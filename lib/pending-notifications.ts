/**
 * Background results that have finished but have not reached the conversation yet.
 *
 * A background command or subagent run can settle while its parent session is deep in a run.
 * The report itself arrives when that run ends (pi drains its follow-up queue there), so between
 * those two moments the parent has no way to know a result exists. This registry is that missing
 * index: one entry per settled report, read back by the `pending_notifications` tool, and nothing
 * else. It holds no output — only what the model needs to decide whether to go and fetch it.
 *
 * "Delivered" is read off the parent's own transcript rather than tracked here: a batch message
 * carries its id in its `details`, so every report it carried is gone from the list the moment
 * the message reaches the session, without this module guessing when pi appended it.
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
  /** The report's own custom type, which decides the card that renders it. */
  customType: string;
  /**
   * The batch message this report rides in, written into its `details.notificationId`. One id
   * per message, so a batch landing clears every report it carried at once.
   */
  messageId: string;
  /** How to fetch the whole result, spelled so the model can copy it out of the list. */
  fetchHint: string;
}

/** The tool the model calls to read this registry. Named in the model-only report prefixes. */
export const PENDING_TOOL_NAME = "pending_notifications";

/** The custom message type the reminder is steered under. */
export const PENDING_POINTER_CUSTOM_TYPE = "pi-web:pending-pointer";

/**
 * The reminder's own guard, for the same reason the reports carry one: pi replays a custom
 * message as a `user` turn, so without this a compaction pass would file "there are background
 * results waiting" under the user's goals and constraints.
 */
export const PENDING_POINTER_PREFIX =
  "The following is not a message from the user: a reminder that background results exist. Look now or finish what you are doing.\n\n";

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

/**
 * Drop a report the parent has collected: reading the result is seeing it, so the index must not
 * keep listing it and the turn-boundary reminder must stop naming it.
 */
export function removePendingNotification(parentSessionId: string, kind: PendingNotificationKind, id: string): void {
  const registry = getPendingRegistry();
  const list = registry.get(parentSessionId);
  if (!list) return;
  const remaining = list.filter((entry) => entry.kind !== kind || entry.id !== id);
  if (remaining.length === 0) registry.delete(parentSessionId);
  else if (remaining.length !== list.length) registry.set(parentSessionId, remaining);
}

/**
 * The markers of the reports already present in a session's transcript.
 *
 * A custom message is appended as a `custom_message` entry whose `details` sits at the
 * entry's top level (`appendCustomMessageEntry()`, `core/session-manager.js`) and
 * `getEntries()` hands back those raw entries, so reading `entry.message.details` finds
 * nothing and a delivered batch keeps overstating the backlog.
 */
export function deliveredNotificationIds(entries: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries as readonly { type?: string; details?: unknown }[]) {
    if (entry?.type !== "custom_message") continue;
    const details = entry.details as { notificationId?: unknown } | undefined;
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
  const pending = list.filter((entry) => !delivered.has(entry.messageId));
  if (pending.length === 0) registry.delete(parentSessionId);
  else if (pending.length !== list.length) registry.set(parentSessionId, pending);
  return [...pending].sort((a, b) => b.finishedAtMs - a.finishedAtMs);
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
  // An empty answer must not invite another call: only the reminder names a new batch.
  if (pending.length === 0) return "No pending background results. Do not call this again until a reminder says results are waiting.";
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

/**
 * The one line steered at a turn boundary when results are waiting. It names the count and the
 * split, because a model that knows there are three answers differently from one that knows
 * there is "some" — and it names the tool, so looking is one call away.
 */
export function formatPendingPointer(pending: readonly PendingNotification[]): string {
  if (pending.length === 0) return "";
  const bash = pending.filter((entry) => entry.kind === "bash").length;
  const agents = pending.length - bash;
  const kinds = [
    bash > 0 ? `${bash} 个 bash 命令` : "",
    agents > 0 ? `${agents} 个子代理` : "",
  ].filter(Boolean).join("、");
  return `${PENDING_POINTER_PREFIX}您有 ${pending.length} 条未处理的后台通知（${kinds}）。现在可以调用 ${PENDING_TOOL_NAME} 查看；没有这条提醒时不要调用。`;
}
