import { lstatSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  BG_LOG_DIR,
  BG_LOG_UNASSIGNED_DIR,
  bgLogDirName,
  countBgTaskLogLines,
  newBgLogPath,
} from "./bg-task-log.ts";
import {
  BG_TASK_NOTIFICATION_CUSTOM_TYPE,
  describeBgTaskOutcome,
  type BgTaskOutcome,
} from "./bg-task-notification.ts";
import { bgTaskHandle } from "./bg-task-handle.ts";
import { bgTaskFetchHint } from "./get-result-tool.ts";
import { pendingTitleFrom } from "./pending-notifications.ts";
import type { SettledReportSink } from "./settled-report-note.ts";

/**
 * Foreground bash commands that outlive this switch to background mode, where
 * the process keeps running and the turn is released. Stated in the tool's
 * prompt so the model knows the number instead of discovering it.
 */
export const FOREGROUND_AUTO_BACKGROUND_MS = 120_000;

/** Cap on the pre-handoff output kept in memory before it spills to the log file. */
const BUFFER_CAP_BYTES = 4 * 1024 * 1024;

/** A background log goes this long after its last write. */
const BG_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Hand out a task's log path, sweeping on the way. The startup sweep
 * (`registerNodeInstrumentation()`) is the one that does not need a task to start.
 */
export function bgLogPath(sessionId?: string): string {
  const path = newBgLogPath(sessionId);
  pruneBgLogs();
  return path;
}

/**
 * Remove a deleted session's log directory: its files, then the directory.
 *
 * The session-delete path (`lib/session-delete.ts`) calls this per deleted id. It
 * never throws: a log left behind is a leak the sweep picks up, while a throw here
 * would stop a session delete half-way through.
 */
export function deleteBgLogsForSession(sessionId: string): void {
  // Only a session's own directory. An id the pattern refuses is never one safe
  // component, and the `_unassigned` bucket is shared by every unknown session,
  // so it is never this function's to remove.
  if (bgLogDirName(sessionId) !== sessionId || sessionId === BG_LOG_UNASSIGNED_DIR) return;
  const dir = join(BG_LOG_DIR, sessionId);
  try {
    // lstat first: a directory left behind as a symlink is dropped as a link, never
    // followed out of BG_LOG_DIR. `rmSync`'s own recursion lstats too.
    if (lstatSync(dir).isSymbolicLink()) {
      unlinkSync(dir);
      return;
    }
    // `force` is the ENOENT of a session that never ran a background command.
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A log Windows still holds open, or a directory that was never there: the sweep gets it.
  }
}

/**
 * A task's log is worth a day; the sweep keys on mtime, which a task still running keeps fresh by
 * writing. Two shapes go: a session directory's stale logs, and a session directory left empty.
 * Nothing here throws.
 */
export function pruneBgLogs(dir: string = BG_LOG_DIR): void {
  const deadline = Date.now() - BG_LOG_RETENTION_MS;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no log directory yet, or it went away mid-sweep
  }
  for (const entry of entries) {
    // Only a session's directory is this sweep's business. A symlink, a socket or a foreign
    // file is left alone: following one out of BG_LOG_DIR is what the name check refuses.
    if (!entry.isDirectory()) continue;
    try {
      pruneBgLogSessionDir(join(dir, entry.name), deadline);
    } catch {
      // Windows refuses an unlink while the writer still holds the file; the next sweep gets it.
    }
  }
}

/** One session's log directory: its stale logs out, then the directory itself once it has held nothing for a day. */
function pruneBgLogSessionDir(dir: string, deadline: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    try {
      const path = join(dir, name);
      // lstat, so a link inside the directory is read as itself and not as its target.
      if (lstatSync(path).mtimeMs < deadline) unlinkSync(path);
    } catch {
      // Still held open, or not a plain file: the next sweep gets it.
    }
  }
  try {
    // Only a directory untouched for a day. Adding a log to it re-stamps it, so a task
    // starting now cannot lose its directory under its own `createWriteStream`; and
    // removing the last log re-stamps it as well, so an emptied directory dies one
    // sweep later than its last log. `rmdirSync` itself refuses a non-empty one.
    if (statSync(dir).mtimeMs < deadline) rmdirSync(dir);
  } catch {
    // Still holds logs, or vanished.
  }
}

/** Raw stdout/stderr chunks captured before a foreground command hands off to background. */
export class PreHandoffBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private overflowed = false;

  push(data: Buffer): void {
    if (this.bytes >= BUFFER_CAP_BYTES) {
      this.overflowed = true;
      return;
    }
    this.chunks.push(Buffer.from(data));
    this.bytes += data.length;
  }

  /** Every buffered chunk, oldest first. After overflow a marker replaces the head. */
  dump(): Buffer[] {
    const parts = [...this.chunks];
    if (this.overflowed) {
      parts.unshift(Buffer.from(`[... earlier output truncated ...]\n`));
    }
    return parts;
  }
}

interface HostSession {
  readonly inner: {
    sendCustomMessage(message: { customType: string; content: string; display: boolean; details?: undefined }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
  };
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface BgTaskNotifierDependencies {
  getSession(sessionId: string): HostSession | undefined;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
}

export interface BgTaskNotifier {
  /** Deliver a finished task's report; `outcome` is what the report was built from. */
  notify(sessionId: string, text: string, outcome: BgTaskOutcome): Promise<void>;
}

export function createBgTaskNotifier(deps: BgTaskNotifierDependencies, sink: SettledReportSink): BgTaskNotifier {
  return {
    async notify(sessionId, text, outcome) {
      let session = deps.getSession(sessionId);
      if (!session?.isAlive()) {
        const sessionFile = await deps.resolveSessionPath(sessionId);
        if (!sessionFile) return;
        session = await deps.reopenSession(sessionId, sessionFile);
      }
      await session.waitUntilReady();
      const handle = bgTaskHandle(outcome.logPath);
      // The parent already fetched this result through `get_result`; the report would repeat what
      // it holds. `take` rather than `has`, so the mark lives exactly one report.
      if (takeBgTaskResultConsumed(handle)) return;
      // The report joins the batch already in the parent's queue, so a run of tasks that finish
      // together reaches the model as one message rather than one message per task.
      await sink.deliver(sessionId, {
        kind: "bash",
        id: handle,
        title: pendingTitleFrom(outcome.command),
        outcome: describeBgTaskOutcome(outcome),
        finishedAtMs: outcome.finishedAtMs,
        customType: BG_TASK_NOTIFICATION_CUSTOM_TYPE,
        fetchHint: bgTaskFetchHint(handle),
        lines: (await countBgTaskLogLines(outcome.logPath)) ?? undefined,
        text,
      });
    },
  };
}

/**
 * Handles whose result the parent already collected, bounded so a long session's set stays small.
 * A handle names one task, so the mark needs no run identity the way a resumed subagent does.
 */
function consumedBgTaskResults(): Map<string, true> {
  const host = globalThis as { __piBgTaskConsumedResults?: Map<string, true> };
  if (!(host.__piBgTaskConsumedResults instanceof Map)) host.__piBgTaskConsumedResults = new Map();
  return host.__piBgTaskConsumedResults;
}

/** The parent fetched this task's result, so its report must not be delivered as well. */
export function recordBgTaskResultConsumed(handle: string): void {
  const marks = consumedBgTaskResults();
  marks.delete(handle);
  marks.set(handle, true);
  while (marks.size > 500) {
    const oldest = marks.keys().next().value;
    if (oldest === undefined) break;
    marks.delete(oldest);
  }
}

/** Take the mark for this handle, if the parent left one. */
export function takeBgTaskResultConsumed(handle: string): boolean {
  return consumedBgTaskResults().delete(handle);
}

// The live-task registry lives on `globalThis` (lib/bg-task-registry.ts), because the routes that list
// and stop a task are bundled into another module graph than this one.
export {
  getBgTask,
  hasLiveBgTasks,
  killBgTask,
  killBgTasksForSession,
  listBgTasks,
  noteBgTaskOutput,
  promoteBgTask,
  settleBgTask,
  trackBgTask,
  untrackBgTask,
  wasBgTaskKilled,
} from "./bg-task-registry.ts";
