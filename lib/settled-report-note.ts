import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "./types";
import { recordPendingNotification, removePendingNotification, type PendingNotification, type PendingNotificationKind } from "./pending-notifications";

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
 * How many times a batch pi took and then let go of is put back before the sink gives up on it.
 * One retry covers the ordinary case; a parent that drops it twice is not going to hold it, and a
 * note kept as queued after that would swallow every report that came after it.
 */
const DROPPED_NOTE_RESENDS = 1;

/**
 * How a busy parent is retried: 500 ms doubling to a 30 s cap, plus up to 200 ms of jitter so a
 * burst of reports does not retry in lockstep. One initial attempt plus seven retries, after which
 * the batch is dead-lettered — never dropped without a trace.
 */
const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DELIVERY_MAX_ATTEMPTS = 8;

/**
 * The dead-letter box: one JSON record per batch nothing could deliver, named after the batch's
 * `notificationId` so a record can be read and removed without touching its neighbours.
 */
const SETTLED_REPORT_DEAD_LETTER_DIR = join(tmpdir(), "pi-web-dead-letters");

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
  /** The parent this batch was queued on; its queue is where a withdrawn batch is taken back. */
  parent: SettledReportParent;
  blocks: TextContent[];
  reports: SettledReport[];
  queued: boolean;
  consumed: boolean;
  /** How many times a batch pi dropped has been put back. */
  requeued: number;
  /** Drops the consume listener when the batch never reaches pi's queue. */
  stopWatching: () => void;
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
  /** Wait between delivery retries; a test supplies a no-op so it does not sleep the schedule. */
  sleep?(ms: number): Promise<void>;
}

export interface SettledReportSink {
  /** Hand a settled report to its parent, appending it to the batch already in the queue. */
  deliver(sessionId: string, report: SettledReport): Promise<void>;
  /**
   * Take a report back because its parent already collected the result: it leaves the batch and
   * the pending index, and a batch left empty is taken out of pi's queue.
   */
  withdraw(sessionId: string, kind: PendingNotificationKind, id: string): void;
}

export function createSettledReportSink(deps: SettledReportSinkDependencies): SettledReportSink {
  /** One note per parent session: the batch currently queued, or the one being built. */
  const notes = new Map<string, SettledReportNote>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function resolveParent(sessionId: string): Promise<SettledReportParent | undefined> {
    const live = deps.getSession(sessionId);
    if (live?.isAlive()) return live;
    const sessionFile = await deps.resolveSessionPath(sessionId);
    if (!sessionFile) return undefined;
    const reopened = await deps.reopenSession(sessionId, sessionFile);
    return reopened.isAlive() ? reopened : undefined;
  }

  /** Freeze the note's arrays the moment pi appends its message. */
  function watchForConsume(parent: SettledReportParent, sessionId: string, note: SettledReportNote): () => void {
    if (!parent.inner.subscribe) return () => {};
    const unsubscribe = parent.inner.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "message_end") return;
      const message = event.message as { customType?: string; details?: { notificationId?: unknown } } | undefined;
      if (message?.customType !== SETTLED_REPORTS_CUSTOM_TYPE) return;
      if (message.details?.notificationId !== note.notificationId) return;
      note.consumed = true;
      unsubscribe();
    });
    return unsubscribe;
  }

  /** Queue the batch, appended in place, as one follow-up: only the first attempt may start a turn. */
  async function sendNote(parent: SettledReportParent, note: SettledReportNote, retry: boolean): Promise<void> {
    await parent.inner.sendCustomMessage({
      customType: SETTLED_REPORTS_CUSTOM_TYPE,
      content: note.blocks,
      display: true,
      details: {
        kind: SETTLED_REPORTS_DETAILS_KIND,
        notificationId: note.notificationId,
        reports: note.reports,
      },
    }, { deliverAs: "followUp", triggerTurn: !retry });
  }

  /** A run started between the state check and the send; the parent is streaming, not broken. */
  function isBusy(error: unknown): boolean {
    return /already processing/i.test(error instanceof Error ? error.message : String(error));
  }

  /** The messages pi's follow-up queue holds, or null when that queue cannot be read. */
  function queuedNotes(note: SettledReportNote): unknown[] | null {
    const queue = (note.parent.inner as { agent?: { followUpQueue?: { messages?: unknown[] } } })
      .agent?.followUpQueue?.messages;
    return Array.isArray(queue) ? queue : null;
  }

  /**
   * Where pi keeps a queued note, if it keeps it at all: the element whose content is the array it
   * was handed. pi stores that array by reference and drains the same array, which is why a batch
   * grows in place; finding the element by that identity is the same property used the other way.
   * `null` means the queue cannot be read at all, which is not the same answer as "not there".
   */
  function queuedNoteIndex(note: SettledReportNote): number | null {
    const queue = queuedNotes(note);
    if (!queue) return null;
    return queue.findIndex((message) => (message as { content?: unknown } | null)?.content === note.blocks);
  }

  /**
   * Whether pi still holds a queued batch. A queue this weak on internals answers "held": that is
   * the only reading which cannot send a report twice, and a dropped batch is only ever noticed on
   * a queue that can actually be read.
   */
  function parentHoldsNote(note: SettledReportNote): boolean {
    const index = queuedNoteIndex(note);
    return index === null || index >= 0;
  }

  /**
   * Take the note's place back out of pi's follow-up queue. pi stores the content array it was
   * handed by reference and drains that same array, which is why a batch grows in place; removing
   * the element by that identity is the same property used the other way. A queue this weak on
   * internals only answers false: the empty batch is harmless on the wire (every provider drops an
   * empty user message) and the next report opens a fresh note.
   */
  function dropQueuedNote(note: SettledReportNote): boolean {
    const index = queuedNoteIndex(note);
    if (index === null || index < 0) return false;
    queuedNotes(note)!.splice(index, 1);
    return true;
  }

  function retryDelayMs(attempt: number): number {
    const backoff = DELIVERY_RETRY_BASE_MS * 2 ** (attempt - 1);
    return Math.min(DELIVERY_RETRY_MAX_MS, backoff + Math.random() * DELIVERY_RETRY_JITTER_MS);
  }

  /**
   * Record a batch that exhausted its retries, so an undelivered report is never lost without a
   * trace. One file per batch, so a record is readable and removable on its own.
   */
  function writeDeadLetter(sessionId: string, note: SettledReportNote, attempts: number, error: unknown): void {
    try {
      mkdirSync(SETTLED_REPORT_DEAD_LETTER_DIR, { recursive: true });
      const record = {
        sessionId,
        notificationId: note.notificationId,
        failedAtMs: Date.now(),
        attempts,
        error: error instanceof Error ? error.message : String(error),
        reports: note.reports,
      };
      writeFileSync(join(SETTLED_REPORT_DEAD_LETTER_DIR, `${note.notificationId}.json`), `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      // A record we cannot write must not take the caller down: the caller still logs the failure.
    }
  }

  /**
   * Deliver the batch, retrying a busy parent on the backoff schedule. Any other failure, and a
   * busy parent that never clears, is dead-lettered; the error is rethrown so the caller logs it.
   */
  async function deliverBatch(parent: SettledReportParent, sessionId: string, note: SettledReportNote): Promise<void> {
    for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
      try {
        await sendNote(parent, note, attempt > 1);
        return;
      } catch (error) {
        if (!isBusy(error) || attempt === DELIVERY_MAX_ATTEMPTS) {
          writeDeadLetter(sessionId, note, attempt, error);
          throw error;
        }
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  /** Forget a batch that can never reach its parent, so the next report opens a fresh one. */
  function forgetNote(sessionId: string, note: SettledReportNote): void {
    note.stopWatching();
    notes.delete(sessionId);
  }

  /**
   * Put a batch pi no longer holds back into its queue. The follow-up queue lives in the wrapper,
   * so a batch queued there is lost when that wrapper is released and the reopened parent starts
   * with an empty queue. A note still marked queued after that carries every report that lands
   * later into a message nobody can deliver, and the silence never ends by itself — so a dropped
   * batch goes back, and one dropped twice is abandoned instead.
   *
   * Only ever called while the parent is idle: between draining its follow-up queue and appending
   * what it drained there is a moment when pi holds nothing and has written nothing, and a batch
   * read as dropped there would be delivered twice. An idle parent has no such moment.
   * A send that fails leaves the note queued here, and the next report tries again.
   */
  async function resendDroppedNote(sessionId: string, parent: SettledReportParent, note: SettledReportNote): Promise<void> {
    note.requeued++;
    if (note.parent !== parent) {
      // The wrapper the batch was queued on is gone and its queue went with it, so the append, and
      // the freeze that follows it, will happen on this one.
      note.stopWatching();
      note.parent = parent;
      note.stopWatching = watchForConsume(parent, sessionId, note);
    }
    try {
      // Not a retry: a batch that never landed still owes the parent the turn it was meant to wake.
      await sendNote(parent, note, false);
    } catch {
      // The parent refused even a queued message. The batch stays as it is and the next report
      // puts it back, until the retries run out and the note is abandoned.
    }
  }

  return {
    async deliver(sessionId, report) {
      const parent = await resolveParent(sessionId);
      if (!parent) return;
      let note = notes.get(sessionId);
      // A note is only worth keeping while its batch can still reach the parent: pi may have let go
      // of it, or the wrapper that held it may have been released with its queue inside. A parent
      // with a run in flight is left alone — its queue is still pi's to drain.
      if (note && note.queued && !note.consumed && !parent.isRunning()
        && (!note.parent.isAlive() || !parentHoldsNote(note))) {
        if (note.requeued >= DROPPED_NOTE_RESENDS) {
          forgetNote(sessionId, note);
          note = undefined;
        } else {
          await resendDroppedNote(sessionId, parent, note);
        }
      }
      if (!note || note.consumed) {
        note = { notificationId: randomUUID().slice(0, 8), parent, blocks: [], reports: [], queued: false, consumed: false, requeued: 0, stopWatching: () => {} };
        notes.set(sessionId, note);
        note.stopWatching = watchForConsume(parent, sessionId, note);
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
        await deliverBatch(parent, sessionId, note);
      } catch (error) {
        // The batch never reached pi's queue, so a later report must open a fresh note rather
        // than append to a message that will never be sent.
        forgetNote(sessionId, note);
        throw error;
      }
    },

    withdraw(sessionId, kind, id) {
      // The index is the parent's own record of what it has not seen, and collecting the result
      // is exactly seeing it.
      removePendingNotification(sessionId, kind, id);
      const note = notes.get(sessionId);
      if (!note) return;
      for (let index = note.reports.length - 1; index >= 0; index--) {
        if (note.reports[index].kind !== kind || note.reports[index].id !== id) continue;
        note.reports.splice(index, 1);
        note.blocks.splice(index, 1);
      }
      if (note.reports.length > 0) return;
      // Nothing left to wake the parent for. Take the empty message out if pi still holds it, and
      // drop the note either way: a note kept because the queue lookup is weak would swallow the
      // next report exactly as the lost batch did.
      if (!note.consumed) dropQueuedNote(note);
      note.stopWatching();
      notes.delete(sessionId);
    },
  };
}
