import type { InlineExtension, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_COMPACTION_GUARD_EXTENSION_NAME = "pi-web-subagent-compaction-guard";

/**
 * The id of the branch's last message the model sees when that message is a finished answer:
 * an assistant message whose last content block is text and whose stop reason is `stop`. A
 * response ending in a tool call or thinking is unfinished work, and so is one that was cut
 * short (`length`), aborted, or errored. Entries the model never reads are stepped over; a
 * message it does read (a user turn, a delivered report) means it has new work in hand.
 */
export function answerTextEntryId(entries: readonly SessionEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom_message") return undefined;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant" || message.stopReason !== "stop") return undefined;
    const last = message.content[message.content.length - 1];
    return last?.type === "text" && last.text.trim().length > 0 ? entry.id : undefined;
  }
  return undefined;
}

/** Whether this compaction is the one the trigger picked without being asked for. */
function isThresholdCompaction(event: Pick<SessionBeforeCompactEvent, "reason">): boolean {
  return event.reason === "threshold";
}

/**
 * Hold the automatic threshold compaction of a subagent that just wrote its answer, so the
 * report is not summarised away the moment the run ends. Manual `/compact` and context-overflow
 * recovery are never held: the first is the user asking, the second means the next request
 * cannot go out without it. Each answer is held once, so the next prompt still compacts first
 * rather than carrying a full context into a new run.
 */
export function createSubagentCompactionGuardExtension(): InlineExtension {
  return {
    name: SUBAGENT_COMPACTION_GUARD_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      let heldFor: string | undefined;
      pi.on("session_before_compact", (event) => {
        if (!isThresholdCompaction(event)) return undefined;
        const answerId = answerTextEntryId(event.branchEntries);
        if (answerId === undefined) {
          heldFor = undefined;
          return undefined;
        }
        if (heldFor === answerId) return undefined;
        heldFor = answerId;
        return { cancel: true };
      });
    },
  };
}
