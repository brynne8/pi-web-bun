import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  BG_TASK_NOTIFICATION_CUSTOM_TYPE,
  describeBgTaskOutcome,
  type BgTaskOutcome,
} from "./bg-task-notification";
import { pendingTitleFrom } from "./pending-notifications";
import type { SettledReportSink } from "./settled-report-note";
import { SESSION_ID_PATTERN } from "./session-ui-state-shared";

/**
 * Foreground bash commands that outlive this switch to background mode, where
 * the process keeps running and the turn is released. Stated in the tool's
 * prompt so the model knows the number instead of discovering it.
 */
export const FOREGROUND_AUTO_BACKGROUND_MS = 120_000;

/** Cap on the pre-handoff output kept in memory before it spills to the log file. */
const BUFFER_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Where spill logs live: `<BG_LOG_DIR>/<sessionId>/<name>.log`, one directory per
 * session so that deleting a session can take its logs with it
 * (`deleteBgLogsForSession`) — a flat file named after nothing, which is what this
 * was, could never be found again from the session that owned it.
 */
const BG_LOG_DIR = join(tmpdir(), "pi-web-bg-tasks");

/**
 * Bucket for a task whose session id is unknown. Its leading `_` is a name
 * `SESSION_ID_PATTERN` can never produce, so it can never collide with a real
 * session's directory, and no session delete can ever be aimed at it. Logs here
 * are kept only by the sweep.
 */
const BG_LOG_UNASSIGNED_DIR = "_unassigned";

/** A pi session id is a UUID; a longer string is not one and does not become a directory name. */
const MAX_BG_LOG_SESSION_ID_LENGTH = 128;

/** A background log goes this long after its last write. */
const BG_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The one directory name a session's logs may live in: the id itself when it is a
 * single safe path component (`SESSION_ID_PATTERN`, the rule the session id is
 * already validated with everywhere else), otherwise the shared bucket — never the
 * root directory, and never a `..` or a separator on its way out of `BG_LOG_DIR`.
 */
function bgLogDirName(sessionId?: string): string {
  if (!sessionId || sessionId.length > MAX_BG_LOG_SESSION_ID_LENGTH) return BG_LOG_UNASSIGNED_DIR;
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : BG_LOG_UNASSIGNED_DIR;
}

/**
 * Hand out a task's log path, sweeping on the way. The startup sweep
 * (`registerNodeInstrumentation()`) is the one that does not need a task to start.
 */
export function bgLogPath(sessionId?: string): string {
  const dir = join(BG_LOG_DIR, bgLogDirName(sessionId));
  mkdirSync(dir, { recursive: true });
  pruneBgLogs();
  return join(dir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.log`);
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
 * A log is read again only by the report that names its path, so a task's log is
 * worth a day; the sweep keys on mtime, which a task still running keeps fresh by
 * writing. Three shapes go: the flat `*.log` files left in the root by the layout
 * that had no per-session directories, a session directory's stale logs, and a
 * session directory left empty. Nothing here throws.
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
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        pruneBgLogSessionDir(path, deadline);
      } else if (entry.isFile() && entry.name.endsWith(".log")) {
        // A flat log from before logs moved into per-session directories.
        if (statSync(path).mtimeMs < deadline) unlinkSync(path);
      }
      // Anything else — a symlink, a socket, a foreign file — is not ours to touch,
      // and following it out of BG_LOG_DIR is exactly what the name check refuses to.
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
      // The report joins the batch already in the parent's queue, so a run of tasks that finish
      // together reaches the model as one message rather than one message per task.
      await sink.deliver(sessionId, {
        kind: "bash",
        id: basename(outcome.logPath),
        title: pendingTitleFrom(outcome.command),
        outcome: describeBgTaskOutcome(outcome),
        finishedAtMs: outcome.finishedAtMs,
        customType: BG_TASK_NOTIFICATION_CUSTOM_TYPE,
        fetchHint: `read("${outcome.logPath}")`,
        text,
      });
    },
  };
}

/** Abort controllers of live background tasks, so a destroyed session does not orphan them. */
const sessionBgControllers = new Map<string, Set<AbortController>>();

export function trackBgTask(sessionId: string, controller: AbortController): void {
  let set = sessionBgControllers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionBgControllers.set(sessionId, set);
  }
  set.add(controller);
}

export function untrackBgTask(sessionId: string, controller: AbortController): void {
  const set = sessionBgControllers.get(sessionId);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) sessionBgControllers.delete(sessionId);
}

export function killBgTasksForSession(sessionId: string): void {
  const set = sessionBgControllers.get(sessionId);
  if (!set) return;
  sessionBgControllers.delete(sessionId);
  for (const controller of set) controller.abort();
}
