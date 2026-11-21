/**
 * A settled background report and the message it rides in, in the shape both sides read.
 *
 * Client-safe (no node imports, no reads): the sink that delivers a batch and the rail that lists
 * what was delivered share these two names and this one shape.
 */

/**
 * One settled background report: what the model reads, and what its card renders.
 *
 * `text` is the report in the shape it has always had — the background-bash report, or the
 * subagent notification — because that text is both the model's input and the card's source.
 * Nothing here is a second copy of it.
 */
export interface SettledReport {
  kind: "bash" | "subagent";
  /** The run's own id: the subagent session id, or a background command's handle. */
  id: string;
  title: string;
  outcome: string;
  finishedAtMs: number;
  /** The report's own custom type, which decides the card that renders it. */
  customType: string;
  fetchHint: string;
  /** How many lines the result holds, when it has that shape (a background command's log). */
  lines?: number;
  /** What the model reads for this report, and what its card renders. */
  text: string;
  /** Whatever that report's card used to carry in `details`, kept per report. */
  details?: unknown;
}

/** How a report ended, in the shapes the two producers emit. */
export type ReportStatus =
  | { state: "completed" }
  | { state: "exit"; code: number }
  | { state: "signal" }
  | { state: "stopped" }
  | { state: "failed"; detail?: string };

/**
 * A report's `outcome` read back as something a row can say in any language.
 *
 * `outcome` is the model's own sentence — `completed`, `exited with code 1`, `terminated by a
 * signal` from a background command, `failed` / `aborted` / `interrupted` from a subagent — and it
 * stays the text the report carries. This is only for display, so an unknown sentence degrades to
 * `failed` with its own words rather than to nothing.
 */
export function parseReportOutcome(outcome: string): ReportStatus {
  if (outcome === "completed") return { state: "completed" };
  const exit = /^exited with code (-?\d+)$/.exec(outcome);
  if (exit) return { state: "exit", code: Number(exit[1]) };
  if (outcome === "terminated by a signal") return { state: "signal" };
  if (outcome === "aborted" || outcome === "interrupted") return { state: "stopped" };
  const failed = /^failed(?: \((.*)\))?$/.exec(outcome);
  if (failed) return { state: "failed", ...(failed[1] ? { detail: failed[1] } : {}) };
  return { state: "failed", ...(outcome ? { detail: outcome } : {}) };
}

/** The custom message type a batch of settled reports is delivered under. */
export const SETTLED_REPORTS_CUSTOM_TYPE = "pi-web:settled-reports";

/** The `details.kind` that marks a message as one of these batches. */
export const SETTLED_REPORTS_DETAILS_KIND = "pi-web-settled-reports";
