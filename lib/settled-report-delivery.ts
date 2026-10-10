import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** A finished run's report, as one `custom` message. */
export type SettledReportMessage = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};

/** The part of a live parent session a report needs. */
export type SettledReportParent = {
  isAlive(): boolean;
  isRunning(): boolean;
  inner: {
    sendCustomMessage(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
    ): Promise<void>;
    subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
    /** pi's low-level Agent; only its queue mode is read here. */
    agent?: { followUpMode?: "all" | "one-at-a-time"; state?: unknown };
  };
};

/**
 * Hand a finished background run's report to its parent session.
 *
 * Nothing is held back for a busy parent: pi queues a message that arrives mid-run and appends
 * it when that turn ends, so the wait is bounded by one turn instead of by however long the
 * parent keeps working. Holding it ourselves until the wrapper looked idle is what let ten
 * tasks that finished over forty minutes deliver as one burst at the first idle moment.
 *
 * Queued follow-ups drain through `Agent.followUpQueue`, whose mode pi leaves at
 * `one-at-a-time` — and that mode drains *only the first* queued message, so a burst would
 * wake the parent once per report, each wake waiting out the previous report's turn. The mode
 * is therefore raised to `all` for the delivery, so the whole queue lands in one turn, and put
 * back when the run ends. `setFollowUpMode` is not used because it writes the settings file the
 * pi CLI shares; a background report is no place to change an editor-wide choice.
 */
export async function deliverSettledReport(parent: SettledReportParent, message: SettledReportMessage): Promise<void> {
  if (!parent.isAlive()) return;
  const inner = parent.inner;
  if (parent.isRunning() && inner.agent && inner.agent.followUpMode !== "all") {
    const previous = inner.agent.followUpMode;
    inner.agent.followUpMode = "all";
    restoreFollowUpModeOnSettle(parent, previous);
  }
  try {
    await inner.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // A run started between the check and the send, so pi refused the prompt. It is streaming
    // now, and a queued report does not need to trigger a turn of its own.
    if (!/already processing/i.test(text)) throw error;
    await inner.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: false });
  }
}

/** Put the queue mode back once the parent's run ends, the drain having happened by then. */
function restoreFollowUpModeOnSettle(parent: SettledReportParent, previous: "all" | "one-at-a-time" | undefined): void {
  const inner = parent.inner;
  if (!inner.subscribe) return;
  const unsubscribe = inner.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "agent_end") return;
    unsubscribe();
    if (inner.agent && inner.agent.followUpMode === "all") inner.agent.followUpMode = previous;
  });
}
