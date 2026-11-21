/**
 * The background results a person can see, in the rail's Notifications section.
 *
 * The model is told about a finished command or subagent through a settled report and the pending
 * index; until now nothing said so on screen — a report landed as a card in the transcript and a
 * person who was not looking at that spot never knew. These rows are the index for the person: the
 * same reports, read from the messages the page already holds, plus the ones the server still holds
 * before delivery. No request of its own.
 *
 * Client-safe: no node imports, no reads.
 */

import {
  parseReportOutcome,
  SETTLED_REPORTS_CUSTOM_TYPE,
  SETTLED_REPORTS_DETAILS_KIND,
  type ReportStatus,
  type SettledReport,
} from "./settled-report.ts";
import { GET_RESULT_TOOL_NAME } from "./get-result-tool.ts";

/** How many a person reads at a glance; the rest is a "+N more" underneath. */
export const RAIL_NOTIFICATION_LIMIT = 3;

/**
 * What the server pushes the moment a result settles or is taken back, so the rail adds or removes
 * a row without polling for it: the report exists, so the row exists.
 */
export const RAIL_NOTIFICATION_EVENT_TYPE = "rail_notification";

export interface RailEventReport {
  kind: "bash" | "subagent";
  id: string;
  title: string;
  outcome: string;
  finishedAtMs: number;
}

export interface RailNotificationEvent {
  type: typeof RAIL_NOTIFICATION_EVENT_TYPE;
  /** `pending`: settled, on its way to the parent. `withdrawn`: taken, so it will not arrive. */
  state: "pending" | "withdrawn";
  report: RailEventReport;
}

/** One finished background result, as a row. */
export interface RailNotification {
  kind: "bash" | "subagent";
  /** The result's own id: a command's `bash-3f2a9b1c` handle, or a subagent's session id. */
  id: string;
  /** One line: the command's first line, or the subagent's description. */
  title: string;
  /** The report's own word: `completed`, `exited with code 1`, `failed (…)`. */
  outcome: string;
  /** That same word as something a row can say in any language. */
  status: ReportStatus;
  finishedAtMs: number;
  /**
   * The model took this result with `get_result`. A delivered report is not consumed by being
   * delivered: it sits in the conversation until the model reads it. `consumedAtMs` is when the
   * fetch happened.
   */
  consumed: boolean;
  consumedAtMs?: number;
  /**
   * When pi appended the batch that carried this result, so it reached the conversation. The row
   * is a notification: it leaves a buffer after the result has reached the model, delivered or
   * taken, whichever came first.
   */
  deliveredAtMs?: number;
  /**
   * The entry that carries the report's card, so a click can scroll the transcript to it. Absent
   * while the report is still on its way to the conversation: there is no card yet.
   */
  entryId?: string;
}

/**
 * The reports this session's transcript already holds, newest first.
 *
 * A batch message carries every report it delivered in `details.reports`, so one message can hold
 * several results — each its own row, all sharing that message's `entryId`.
 */
export function settledNotificationsFromMessages(
  messages: readonly unknown[],
  entryIds: readonly (string | undefined)[],
): RailNotification[] {
  const rows: RailNotification[] = [];
  const taken = consumedResults(messages);
  messages.forEach((message, index) => {
    const candidate = message as { role?: unknown; customType?: unknown; details?: unknown; timestamp?: unknown } | undefined;
    if (candidate?.role !== "custom" || candidate.customType !== SETTLED_REPORTS_CUSTOM_TYPE) return;
    const details = candidate.details as { kind?: unknown; reports?: unknown } | undefined;
    if (details?.kind !== SETTLED_REPORTS_DETAILS_KIND || !Array.isArray(details.reports)) return;
    const entryId = entryIds[index];
    for (const report of details.reports as Partial<SettledReport>[]) {
      if (!isRailKind(report?.kind)) continue;
      const outcome = typeof report.outcome === "string" ? report.outcome : "";
      const finishedAtMs = typeof report.finishedAtMs === "number" ? report.finishedAtMs : 0;
      const id = typeof report.id === "string" ? report.id : "";
      const consumedAtMs = consumedAt(taken, id, report.kind);
      rows.push({
        kind: report.kind,
        id,
        title: typeof report.title === "string" ? report.title : "",
        outcome,
        status: parseReportOutcome(outcome),
        finishedAtMs,
        consumed: consumedAtMs !== undefined,
        ...(consumedAtMs ? { consumedAtMs } : {}),
        ...(recordedMs(candidate.timestamp) ? { deliveredAtMs: recordedMs(candidate.timestamp) } : {}),
        ...(entryId ? { entryId } : {}),
      });
    }
  });
  return rows;
}

/**
 * Results the model fetched with `get_result` instead of receiving them.
 *
 * A pending result's handle is offered by `await_results`, and fetching is the sanctioned way to
 * take one — but a fetched report is withdrawn from delivery, so it never becomes a message and
 * never a row of its own. Without these the rail would report three finished commands as one. A
 * fetch that was refused (a command still running, or a handle whose log is gone) answers with an
 * error, and an error is not a finished result: only the successful ones are rows.
 */
export function fetchedNotifications(
  messages: readonly unknown[],
  received: readonly RailNotification[] = [],
): RailNotification[] {
  const failed = new Set<string>();
  for (const message of messages) {
    const result = message as { role?: unknown; toolCallId?: unknown; isError?: unknown } | undefined;
    if (result?.role === "toolResult" && result.isError === true && typeof result.toolCallId === "string") failed.add(result.toolCallId);
  }
  const rows: RailNotification[] = [];
  for (const message of messages) {
    const candidate = message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
    if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) continue;
    const at = recordedMs(candidate.timestamp);
    for (const part of candidate.content) {
      const call = part as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown } | undefined;
      if (call?.type !== "toolCall" || call.name !== GET_RESULT_TOOL_NAME) continue;
      if (typeof call.id === "string" && failed.has(call.id)) continue;
      const id = (call.arguments as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !id) continue;
      const kind = id.startsWith("bash-") ? "bash" : "subagent";
      // A result that also arrived as a batch already has a row, with the card to open; the same
      // subagent answers to its full session id there and to its 8-character prefix here.
      if (received.some((row) => row.kind === kind && (row.id === id || (kind === "subagent" && row.id.startsWith(id))))) continue;
      rows.push({
        kind,
        id,
        title: "",
        outcome: "",
        status: { state: "completed" },
        finishedAtMs: at,
        consumed: true,
        consumedAtMs: at,
      });
    }
  }
  return rows;
}

function isRailKind(kind: unknown): kind is RailNotification["kind"] {
  return kind === "bash" || kind === "subagent";
}

/**
 * The results the model took with `get_result`, by the id it asked for, and when.
 *
 * Taking is what consumes a result: a delivered report only sits in the conversation until the
 * model reads it with its turn, while a fetch is an explicit read. A subagent answers to its
 * 8-character id as well as its full session id, so both are looked up.
 */
export function consumedResults(messages: readonly unknown[]): Map<string, number> {
  const calls = new Map<string, number>();
  for (const message of messages) {
    const candidate = message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
    if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) continue;
    const at = recordedMs(candidate.timestamp);
    for (const part of candidate.content) {
      const call = part as { type?: unknown; name?: unknown; arguments?: unknown } | undefined;
      if (call?.type !== "toolCall" || call.name !== GET_RESULT_TOOL_NAME) continue;
      const id = (call.arguments as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && id) calls.set(id, at);
    }
  }
  return calls;
}

function consumedAt(consumed: Map<string, number>, id: string, kind: RailNotification["kind"]): number | undefined {
  if (!id) return undefined;
  const exact = consumed.get(id);
  if (exact !== undefined) return exact;
  if (kind !== "subagent") return undefined;
  for (const [asked, at] of consumed) if (asked.length === 8 && id.startsWith(asked)) return at;
  return undefined;
}

function recordedMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Delivered and still-arriving results as one list, newest first, each result once.
 *
 * The two sets are disjoint by construction — a report leaves the index as its message lands — but
 * a poll and a render can straddle that moment, so a report the transcript already holds wins over
 * the same report still listed as arriving.
 */
export function mergeRailNotifications(
  delivered: readonly RailNotification[],
  arriving: readonly RailNotification[],
): RailNotification[] {
  const seen = new Set(delivered.map(keyOf));
  const merged = [...delivered];
  for (const entry of arriving) {
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged.sort((a, b) => b.finishedAtMs - a.finishedAtMs);
}

function keyOf(entry: RailNotification): string {
  return `${entry.kind}:${entry.id}`;
}

/**
 * Reports the server still holds for this session, as rows without an `entryId`: there is no card
 * in the transcript to scroll to yet. The shape is the debug snapshot's, so nothing is fetched for
 * it beyond the poll the rail already runs.
 */
export function arrivingNotifications(
  reports: readonly { kind?: unknown; id?: unknown; title?: unknown; outcome?: unknown; finishedAtMs?: unknown }[],
): RailNotification[] {
  const rows: RailNotification[] = [];
  for (const report of reports) {
    if (!isRailKind(report.kind)) continue;
    const outcome = typeof report.outcome === "string" ? report.outcome : "";
    const id = typeof report.id === "string" ? report.id : "";
    rows.push({
      kind: report.kind,
      id,
      title: typeof report.title === "string" ? report.title : "",
      outcome,
      status: parseReportOutcome(outcome),
      finishedAtMs: typeof report.finishedAtMs === "number" ? report.finishedAtMs : 0,
      // A result the model fetched before its delivery is suppressed by the delivery itself, so
      // what is still listed as arriving has not been read.
      consumed: false,
    });
  }
  return rows;
}

/**
 * How long a result stays in the list after it has reached the model — delivered or taken — before
 * the row is removed: the buffer that keeps a notification from either blinking out or settling in
 * as a permanent list. A result still on its way has no clock yet and stays.
 */
export const RAIL_NOTIFICATION_LINGER_MS = 30_000;

/** The rows the section shows, and how many it folds behind them. */
export function railNotificationWindow(
  notifications: readonly RailNotification[],
  limit: number = RAIL_NOTIFICATION_LIMIT,
): { shown: RailNotification[]; hidden: number } {
  return { shown: notifications.slice(0, limit), hidden: Math.max(0, notifications.length - limit) };
}
