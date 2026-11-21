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

/** The custom message type a batch of settled reports is delivered under. */
export const SETTLED_REPORTS_CUSTOM_TYPE = "pi-web:settled-reports";

/** The `details.kind` that marks a message as one of these batches. */
export const SETTLED_REPORTS_DETAILS_KIND = "pi-web-settled-reports";
