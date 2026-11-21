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

import { SETTLED_REPORTS_CUSTOM_TYPE, SETTLED_REPORTS_DETAILS_KIND, type SettledReport } from "./settled-report.ts";

/** How many a person reads at a glance; the rest is a "+N more" underneath. */
export const RAIL_NOTIFICATION_LIMIT = 3;

/** One finished background result, as a row. */
export interface RailNotification {
  kind: "bash" | "subagent";
  /** The result's own id: a command's `bash-3f2a9b1c` handle, or a subagent's session id. */
  id: string;
  /** One line: the command's first line, or the subagent's description. */
  title: string;
  /** The report's own word: `completed`, `exited with code 1`, `failed (…)`. */
  outcome: string;
  finishedAtMs: number;
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
  messages.forEach((message, index) => {
    const candidate = message as { role?: unknown; customType?: unknown; details?: unknown } | undefined;
    if (candidate?.role !== "custom" || candidate.customType !== SETTLED_REPORTS_CUSTOM_TYPE) return;
    const details = candidate.details as { kind?: unknown; reports?: unknown } | undefined;
    if (details?.kind !== SETTLED_REPORTS_DETAILS_KIND || !Array.isArray(details.reports)) return;
    const entryId = entryIds[index];
    for (const report of details.reports as Partial<SettledReport>[]) {
      if (!isRailKind(report?.kind)) continue;
      rows.push({
        kind: report.kind,
        id: typeof report.id === "string" ? report.id : "",
        title: typeof report.title === "string" ? report.title : "",
        outcome: typeof report.outcome === "string" ? report.outcome : "",
        finishedAtMs: typeof report.finishedAtMs === "number" ? report.finishedAtMs : 0,
        ...(entryId ? { entryId } : {}),
      });
    }
  });
  return rows;
}

function isRailKind(kind: unknown): kind is RailNotification["kind"] {
  return kind === "bash" || kind === "subagent";
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
    rows.push({
      kind: report.kind,
      id: typeof report.id === "string" ? report.id : "",
      title: typeof report.title === "string" ? report.title : "",
      outcome: typeof report.outcome === "string" ? report.outcome : "",
      finishedAtMs: typeof report.finishedAtMs === "number" ? report.finishedAtMs : 0,
    });
  }
  return rows;
}

/** The rows the section shows, and how many it folds away behind them. */
export function railNotificationWindow(
  notifications: readonly RailNotification[],
  limit: number = RAIL_NOTIFICATION_LIMIT,
): { shown: RailNotification[]; hidden: number } {
  return { shown: notifications.slice(0, limit), hidden: Math.max(0, notifications.length - limit) };
}
