import { randomBytes } from "node:crypto";
import type { BgTaskSummary } from "./bg-task-types";

/**
 * Live background bash tasks, readable by routes in another module graph.
 *
 * Route handlers get their own module instance (see lib/file-watch-registry.ts), so the map is
 * kept on `globalThis` behind a `Symbol.for`. A foreground command is tracked too, because a
 * session with one has a reason to wait; only a promoted or explicit background entry is listed.
 */
const BG_TASK_REGISTRY: symbol = Symbol.for("pi-web:bg-tasks");

type BgTaskPhase = "foreground" | "background";
type BgTaskTrigger = "background" | "time" | "lines";

interface BgTaskEntry {
  id: string;
  sessionId: string;
  controller: AbortController;
  phase: BgTaskPhase;
  trigger: BgTaskTrigger;
  command: string;
  logPath: string;
  startedAtMs: number;
  lastOutputAtMs: number;
  finishedAtMs: number | null;
  exitCode: number | null;
  error: string | undefined;
  killedByUser: boolean;
}

/** A finished task stays visible this long, so its output can still be read after it ends. */
export const BG_TASK_FINISHED_RETENTION_MS = 10 * 60 * 1000;

function registry(): Map<string, BgTaskEntry> {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[BG_TASK_REGISTRY];
  if (existing instanceof Map) return existing as Map<string, BgTaskEntry>;
  const created = new Map<string, BgTaskEntry>();
  host[BG_TASK_REGISTRY] = created;
  return created;
}

function newTaskId(): string {
  return `bt-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function pruneFinished(now = Date.now()): void {
  for (const [id, entry] of registry()) {
    if (entry.finishedAtMs !== null && now - entry.finishedAtMs > BG_TASK_FINISHED_RETENTION_MS) {
      registry().delete(id);
    }
  }
}

function findByController(controller: AbortController): BgTaskEntry | undefined {
  for (const entry of registry().values()) {
    if (entry.controller === controller) return entry;
  }
  return undefined;
}

/** The client-safe view of one entry. The controller never leaves this module. */
function toBgTaskSummary(entry: BgTaskEntry): BgTaskSummary {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    command: entry.command,
    logPath: entry.logPath,
    startedAtMs: entry.startedAtMs,
    lastOutputAtMs: entry.lastOutputAtMs,
    finishedAtMs: entry.finishedAtMs,
    exitCode: entry.exitCode,
    error: entry.error ?? null,
    trigger: entry.trigger,
    killedByUser: entry.killedByUser,
  };
}

export interface BgTaskStartInfo {
  command?: string;
  logPath?: string;
  startedAtMs?: number;
  trigger?: BgTaskTrigger;
  /** True for `run_in_background`; false for a foreground command that may still hand off. */
  background?: boolean;
}

/**
 * Track a command's controller. A foreground command is hidden until it hands off; the compat
 * shape with no info is what the old `trackBgTask(sessionId, controller)` callers use.
 */
export function trackBgTask(sessionId: string, controller: AbortController, info: BgTaskStartInfo = {}): string {
  const existing = findByController(controller);
  if (existing) return existing.id;
  pruneFinished();
  const entry: BgTaskEntry = {
    id: newTaskId(),
    sessionId,
    controller,
    phase: info.background === true ? "background" : "foreground",
    trigger: info.trigger ?? "background",
    command: info.command ?? "",
    logPath: info.logPath ?? "",
    startedAtMs: info.startedAtMs ?? Date.now(),
    lastOutputAtMs: info.startedAtMs ?? Date.now(),
    finishedAtMs: null,
    exitCode: null,
    error: undefined,
    killedByUser: false,
  };
  registry().set(entry.id, entry);
  return entry.id;
}

/** A foreground command has moved to the background: now it is worth listing. */
export function promoteBgTask(controller: AbortController, info: {
  command: string;
  logPath: string;
  startedAtMs: number;
  trigger: "time" | "lines";
}): void {
  const entry = findByController(controller);
  if (!entry) return;
  entry.phase = "background";
  entry.trigger = info.trigger;
  entry.command = info.command;
  entry.logPath = info.logPath;
  entry.startedAtMs = info.startedAtMs;
  entry.lastOutputAtMs = Date.now();
}

/** A task wrote output, so its idle time starts over. */
export function noteBgTaskOutput(controller: AbortController, now = Date.now()): void {
  const entry = findByController(controller);
  if (entry) entry.lastOutputAtMs = now;
}

/** The process ended: keep a background entry visible for a while, drop a hidden foreground one. */
export function settleBgTask(controller: AbortController, outcome: {
  exitCode: number | null;
  error?: string;
}): void {
  const entry = findByController(controller);
  if (!entry) return;
  entry.finishedAtMs = Date.now();
  entry.exitCode = outcome.exitCode;
  entry.error = outcome.error;
  if (entry.phase === "foreground") registry().delete(entry.id);
}

/** Whether a killed task's own completion report must be suppressed. */
export function wasBgTaskKilled(controller: AbortController): boolean {
  return findByController(controller)?.killedByUser === true;
}

export function untrackBgTask(sessionId: string, controller: AbortController): void {
  const entry = findByController(controller);
  if (!entry || entry.sessionId !== sessionId) return;
  registry().delete(entry.id);
}

/** A session with a foreground command still waits; a finished one does not. */
export function hasLiveBgTasks(sessionId: string): boolean {
  for (const entry of registry().values()) {
    if (entry.sessionId === sessionId && entry.finishedAtMs === null) return true;
  }
  return false;
}

/** Session teardown aborts and forgets its tasks at once, so nothing claims to run afterwards. */
export function killBgTasksForSession(sessionId: string): void {
  for (const [id, entry] of registry()) {
    if (entry.sessionId !== sessionId) continue;
    registry().delete(id);
    entry.controller.abort();
  }
}

/** Everything visible to the panel: running tasks first, then those that just finished. */
export function listBgTasks(now = Date.now()): BgTaskSummary[] {
  pruneFinished(now);
  return [...registry().values()]
    .filter((entry) => entry.phase === "background")
    .sort((a, b) => (a.finishedAtMs ?? Number.MAX_SAFE_INTEGER) - (b.finishedAtMs ?? Number.MAX_SAFE_INTEGER)
      || a.startedAtMs - b.startedAtMs)
    .map(toBgTaskSummary);
}

export function getBgTask(id: string): BgTaskSummary | undefined {
  const entry = registry().get(id);
  return entry?.phase === "background" ? toBgTaskSummary(entry) : undefined;
}

/**
 * Stop one task at the user's request. The entry stays until its process settles, so the
 * completion path can see `killedByUser` and skip the ordinary report.
 */
export function killBgTask(id: string): BgTaskSummary | undefined {
  const entry = registry().get(id);
  if (!entry || entry.phase !== "background" || entry.finishedAtMs !== null) return undefined;
  entry.killedByUser = true;
  entry.controller.abort();
  return toBgTaskSummary(entry);
}
