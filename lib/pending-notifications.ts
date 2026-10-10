/**
 * Background results that have finished but have not reached the conversation yet.
 *
 * A background command or subagent run can settle while its parent session is deep in a run.
 * The report itself arrives when that run ends (pi drains its follow-up queue there), so between
 * those two moments the parent has no way to know a result exists. This registry is that missing
 * index: one entry per settled report, read back by the `pending_notifications` tool, and nothing
 * else. It holds no output — only what the model needs to decide whether to go and fetch it.
 *
 * "Delivered" is read off the parent's own transcript rather than tracked here: the report's
 * custom message carries a marker in its `details`, so a report that has reached the session is
 * gone from the list without this module having to guess when pi appended it.
 */

/** Which kind of background work produced the result. */
export type PendingNotificationKind = "bash" | "subagent";

export interface PendingNotification {
  kind: PendingNotificationKind;
  /** The run's own id: the subagent session id, or the background task's log id. */
  id: string;
  /** One line the parent recognizes: the subagent's description, or the command's first line. */
  title: string;
  /** How it ended, in the report's own words: `completed`, `exited with code 1`, `failed (…)`. */
  outcome: string;
  finishedAtMs: number;
  /** The session the report belongs to, by id — the parent, not the cwd. */
  parentSessionId: string;
  /** The custom message type the report is delivered under. */
  customType: string;
  /** Written into the delivered message's `details`, which is how delivery is recognized. */
  markerId: string;
  /** How to fetch the whole result, spelled so the model can copy it out of the list. */
  fetchHint: string;
}

/** The tool the model calls to read this registry. Named in the model-only report prefixes. */
export const PENDING_TOOL_NAME = "pending_notifications";

/**
 * The sentence both report prefixes carry: the report is the model's first hint that other
 * results may exist, so the pointer belongs there rather than in a second message.
 */
export const PENDING_HINT_SENTENCE =
  "Other background results may have finished in the meantime; call pending_notifications to list the ones still outside this conversation.";

/** Reports kept per parent session, oldest dropped first. An index, not an archive. */
const PENDING_PER_PARENT_LIMIT = 12;

/** Entries listed in full; the rest is counted, never silently dropped. */
const PENDING_DISPLAY_LIMIT = 3;

/** The title's length in the list: long enough to recognize, short enough to scan. */
const PENDING_TITLE_LIMIT = 120;

declare global {
  var __piPendingNotifications: Map<string, PendingNotification[]> | undefined;
}

function getPendingRegistry(): Map<string, PendingNotification[]> {
  if (!globalThis.__piPendingNotifications) globalThis.__piPendingNotifications = new Map();
  return globalThis.__piPendingNotifications;
}

/** A settled report joins its parent's index; a repeat of the same id replaces the older entry. */
export function recordPendingNotification(entry: PendingNotification): void {
  const registry = getPendingRegistry();
  const list = registry.get(entry.parentSessionId) ?? [];
  const previous = list.findIndex((item) => item.kind === entry.kind && item.id === entry.id);
  if (previous !== -1) list.splice(previous, 1);
  list.push(entry);
  while (list.length > PENDING_PER_PARENT_LIMIT) list.shift();
  registry.set(entry.parentSessionId, list);
}

/** The markers of the reports already present in a session's transcript. */
export function deliveredNotificationIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries as readonly { type?: string; message?: { details?: unknown } }[]) {
    if (entry?.type !== "message") continue;
    const details = entry.message?.details as { notificationId?: unknown } | undefined;
    if (typeof details?.notificationId === "string") ids.add(details.notificationId);
  }
  return ids;
}

/**
 * What the parent has not seen yet, newest first. A report that has reached the transcript is
 * dropped from the registry here, so an answered index shrinks by itself.
 */
export function pendingNotificationsFor(parentSessionId: string, entries: readonly unknown[]): PendingNotification[] {
  const registry = getPendingRegistry();
  const list = registry.get(parentSessionId);
  if (!list || list.length === 0) return [];
  const delivered = deliveredNotificationIds(entries);
  const pending = list.filter((entry) => !delivered.has(entry.markerId));
  if (pending.length === 0) registry.delete(parentSessionId);
  else if (pending.length !== list.length) registry.set(parentSessionId, pending);
  return [...pending].sort((a, b) => b.finishedAtMs - a.finishedAtMs);
}

/** The `details` a report message carries so its delivery can be recognized later. */
export function pendingNotificationDetails(markerId: string): { notificationId: string } {
  return { notificationId: markerId };
}

/** One recognizable line out of a longer string: first non-empty line, collapsed, capped. */
export function pendingTitleFrom(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > PENDING_TITLE_LIMIT ? `${line.slice(0, PENDING_TITLE_LIMIT - 1)}…` : line;
}

/** Minutes and hours, rounded down: enough to tell "just now" from "a while ago". */
function formatAgo(finishedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - finishedAtMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * The tool's whole answer. Counts are always exact — only the lines are capped — because a model
 * that underestimates a backlog answers differently than one that knows its size.
 */
export function formatPendingNotifications(
  pending: readonly PendingNotification[],
  nowMs: number = Date.now(),
): string {
  if (pending.length === 0) return "No pending background results.";
  const bash = pending.filter((entry) => entry.kind === "bash").length;
  const counts = [
    bash > 0 ? `${bash} ${bash === 1 ? "command" : "commands"}` : "",
    pending.length - bash > 0 ? `${pending.length - bash} subagent${pending.length - bash === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");
  const lines = [`Pending background results: ${pending.length} (${counts}).`];
  for (const entry of pending.slice(0, PENDING_DISPLAY_LIMIT)) {
    lines.push(`  [${entry.kind}] ${entry.title} · ${entry.outcome} · ${formatAgo(entry.finishedAtMs, nowMs)} → ${entry.fetchHint}`);
  }
  const hidden = pending.length - Math.min(pending.length, PENDING_DISPLAY_LIMIT);
  if (hidden > 0) lines.push(`  +${hidden} more, listed on request by kind.`);
  lines.push("Fetch one with its hint, or leave it: reports you have not seen yet arrive on their own.");
  return lines.join("\n");
}
