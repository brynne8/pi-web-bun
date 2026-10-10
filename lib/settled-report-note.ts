import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { TextContent } from "./types";
import { recordPendingNotification, type PendingNotification } from "./pending-notifications";

/**
 * One settled background report: what the model reads, and what its card renders.
 *
 * `text` is the report in the shape it has always had — the background-bash report, or the
 * subagent notification — because that text is both the model's input and the card's source.
 * Nothing here is a second copy of it.
 */
export interface SettledReport {
  kind: PendingNotification["kind"];
  /** The run's own id: the subagent session id, or the background task's log id. */
  id: string;
  title: string;
  outcome: string;
  finishedAtMs: number;
  /** The report's own custom type, which decides the card that renders it. */
  customType: string;
  fetchHint: string;
  /** What the model reads for this report, and what its card renders. */
  text: string;
  /** Whatever that report's card used to carry in `details`, kept per report. */
  details?: unknown;
}

/** The custom message type a batch of settled reports is delivered under. */
export const SETTLED_REPORTS_CUSTOM_TYPE = "pi-web:settled-reports";

/** The `details.kind` that marks a message as one of these batches. */
export const SETTLED_REPORTS_DETAILS_KIND = "pi-web-settled-reports";

/**
 * A batch waiting for, or riding, its one place in the parent's queue.
 *
 * `blocks` and `reports` are handed to pi **by reference** when the note is queued, so a report
 * that settles later is appended to the message pi is already holding: one queue element, however
 * many reports end up inside it. That is the whole point — a report per queue element would make
 * pi deliver them one turn apart, which is what a burst of finished tasks used to do.
 *
 * `consumed` is set when pi appends the message, because that is the moment it serializes the
 * content into the session file. Appending after that would leave the in-memory entry and the
 * file holding different text, so the arrays are frozen there and the next report opens a note.
 */
type SettledReportNote = {
  notificationId: string;
  blocks: TextContent[];
  reports: SettledReport[];
  queued: boolean;
  consumed: boolean;
};

/** The part of a live parent session a batch needs. */
export interface SettledReportParent {
  isAlive(): boolean;
  isRunning(): boolean;
  inner: {
    sendCustomMessage(
      message: { customType: string; content: string | TextContent[]; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): Promise<void>;
    subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
  };
}

export interface SettledReportSinkDependencies {
  getSession(sessionId: string): SettledReportParent | undefined;
  reopenSession(sessionId: string, sessionFile: string): Promise<SettledReportParent>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
}

export interface SettledReportSink {
  /** Hand a settled report to its parent, appending it to the batch already in the queue. */
  deliver(sessionId: string, report: SettledReport): Promise<void>;
}

export function createSettledReportSink(deps: SettledReportSinkDependencies): SettledReportSink {
  /** One note per parent session: the batch currently queued, or the one being built. */
  const notes = new Map<string, SettledReportNote>();

  async function resolveParent(sessionId: string): Promise<SettledReportParent | undefined> {
    const live = deps.getSession(sessionId);
    if (live?.isAlive()) return live;
    const sessionFile = await deps.resolveSessionPath(sessionId);
    if (!sessionFile) return undefined;
    const reopened = await deps.reopenSession(sessionId, sessionFile);
    return reopened.isAlive() ? reopened : undefined;
  }

  /** Freeze the note's arrays the moment pi appends its message. */
  function watchForConsume(parent: SettledReportParent, sessionId: string, note: SettledReportNote): void {
    if (!parent.inner.subscribe) return;
    const unsubscribe = parent.inner.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "message_end") return;
      const message = event.message as { customType?: string; details?: { notificationId?: unknown } } | undefined;
      if (message?.customType !== SETTLED_REPORTS_CUSTOM_TYPE) return;
      if (message.details?.notificationId !== note.notificationId) return;
      note.consumed = true;
      unsubscribe();
    });
  }

  return {
    async deliver(sessionId, report) {
      const parent = await resolveParent(sessionId);
      if (!parent) return;
      let note = notes.get(sessionId);
      if (!note || note.consumed) {
        note = { notificationId: randomUUID().slice(0, 8), blocks: [], reports: [], queued: false, consumed: false };
        notes.set(sessionId, note);
        watchForConsume(parent, sessionId, note);
      }

      // The report joins the batch before anything is queued, so the message pi takes holds its
      // first element from the start and grows in place afterwards.
      note.reports.push(report);
      note.blocks.push({ type: "text", text: report.text });

      // Indexed for the parent to look up while the batch has not reached it. Keyed by the
      // message, so one batch landing clears every report it carried.
      recordPendingNotification({
        kind: report.kind,
        id: report.id,
        title: report.title,
        outcome: report.outcome,
        finishedAtMs: report.finishedAtMs,
        parentSessionId: sessionId,
        customType: report.customType,
        messageId: note.notificationId,
        fetchHint: report.fetchHint,
      });

      if (note.queued) return;
      note.queued = true;
      try {
        await parent.inner.sendCustomMessage({
          customType: SETTLED_REPORTS_CUSTOM_TYPE,
          content: note.blocks,
          display: true,
          details: {
            kind: SETTLED_REPORTS_DETAILS_KIND,
            notificationId: note.notificationId,
            reports: note.reports,
          },
        }, { deliverAs: "followUp", triggerTurn: true });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        // A run started between the state check and the send, so pi refused the prompt. It is
        // streaming now, and a queued report does not need to trigger a turn of its own.
        if (!/already processing/i.test(text)) throw error;
        await parent.inner.sendCustomMessage({
          customType: SETTLED_REPORTS_CUSTOM_TYPE,
          content: note.blocks,
          display: true,
          details: {
            kind: SETTLED_REPORTS_DETAILS_KIND,
            notificationId: note.notificationId,
            reports: note.reports,
          },
        }, { deliverAs: "followUp", triggerTurn: false });
      }

    },
  };
}
