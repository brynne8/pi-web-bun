import { stripAnsi } from "./ansi.ts";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

const THINKING_PREVIEW_SOURCE_CHARS = 4_000;

/** The thinking's first line, without the terminal escapes a model may write (#1753). */
export function getThinkingPreview(thinking: string): string {
  const head = stripAnsi(thinking.trimStart().slice(0, THINKING_PREVIEW_SOURCE_CHARS)).trimStart();
  return head.match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/**
 * pi's TUI renders a custom message only when `display` is set; `display: false`
 * is how an extension keeps a message for the model alone. The chat skips it too.
 */
export function isHiddenCustomMessage(message: { role?: AgentMessage["role"]; display?: boolean }): boolean {
  return message.role === "custom" && !message.display;
}

/** The fields turn grouping reads; `stopReason` only on assistant replies. */
export interface TurnAnchorMessage {
  role?: AgentMessage["role"];
  customType?: string;
  display?: boolean;
  stopReason?: string;
}

/**
 * The turn anchors that need no context: a user message, the compaction summary,
 * and a background subagent completion, pi-web's own and @tintinweb/pi-subagents'
 * (a follow-up that triggers a turn; pi-web's is steered into a parent's running
 * run, where it opens a turn as a user's steer does). getTurnAnchors() adds the extension
 * messages that started a run of their own, which only the order shows.
 */
export function isMessageGroupAnchor(message: TurnAnchorMessage): boolean {
  return message.role === "user"
    || (message.role === "custom" && !isHiddenCustomMessage(message) && (
      message.customType === "compaction"
      || message.customType === "pi-web:subagent-notification"
      || message.customType === "subagent-notification"
    ));
}

/** A reply its run ended on: a later reply came from a new run. */
function endsRun(message: TurnAnchorMessage | undefined): boolean {
  return message?.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "aborted");
}

function isConversationMessage(message: TurnAnchorMessage): boolean {
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

/**
 * Which of `messages` start a displayed turn: isMessageGroupAnchor()'s, plus
 * an extension message that started a run after the previous one had ended
 * (`sendMessage(…, { triggerTurn: true })` while idle, or a follow-up). pi
 * records no trigger flag, so the order tells it: a stretch of other messages
 * (custom messages, `!` commands) after a reply that ended its run (stop, or
 * Stop) and before the next reply. A reply cut at the output limit is
 * continued in the same run, and so is one an error ended, so their stretches
 * stay inside the turn. The stretch's last shown custom message is the
 * anchor; without one its last custom message, which shows nothing (`display:
 * false`), so the turn starts at its process details or answer. A `!` command
 * after the last shown message stays above the anchor, which is then the
 * hidden message after it: between a turn's anchor and its answer the chat
 * renders only replies and custom messages, so the command's card would be
 * gone. A stretch holding an anchor of its own is left as it is.
 *
 * `openTail`: a run is under way, so a stretch at the end opens the turn it
 * answers. The server counts turns with the same function (`countTurnsBefore()`).
 */
export function getTurnAnchors(
  messages: readonly TurnAnchorMessage[],
  options: { openTail?: boolean } = {},
): boolean[] {
  const anchors = messages.map(isMessageGroupAnchor);
  visitInferredTurnAnchors(messages, anchors, options.openTail === true, (anchor) => { anchors[anchor] = true; });
  return anchors;
}

/** The number of closed turn anchors at each possible end of the transcript. */
export function getClosedTurnCounts(messages: readonly TurnAnchorMessage[]): number[] {
  const anchors = messages.map(isMessageGroupAnchor);
  const counts = anchors.map((anchor) => Number(anchor));
  // An inferred anchor is only visible to a reader whose page reaches the answer.
  visitInferredTurnAnchors(messages, anchors, false, (_anchor, answer) => { counts[answer] += 1; });
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  return counts;
}

function visitInferredTurnAnchors(
  messages: readonly TurnAnchorMessage[],
  anchors: readonly boolean[],
  openTail: boolean,
  visit: (anchor: number, answer: number) => void,
): void {
  for (let start = 0; start < messages.length;) {
    if (isConversationMessage(messages[start])) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < messages.length && !isConversationMessage(messages[end])) end += 1;
    const next = messages[end];
    const answered = next ? next.role === "assistant" : openTail;
    if (answered && endsRun(messages[start - 1]) && !anchors.slice(start, end).includes(true)) {
      let anchor = -1;
      for (let idx = end - 1; idx >= start; idx--) {
        if (messages[idx].role !== "custom") {
          // A `!` command: a hidden message below it opens the turn, so its card stays shown.
          if (anchor !== -1) break;
          continue;
        }
        if (anchor === -1) anchor = idx;
        if (!isHiddenCustomMessage(messages[idx])) {
          anchor = idx;
          break;
        }
      }
      if (anchor !== -1) visit(anchor, end);
    }
    start = end;
  }
}

/**
 * Whether the chat gives the message a scroll ref, which the minimap reads in
 * the same order: assistant replies and the anchors that show. A hidden anchor
 * renders nothing.
 */
export function hasTurnRef(message: TurnAnchorMessage, isAnchor: boolean): boolean {
  return message.role === "assistant" || (isAnchor && !isHiddenCustomMessage(message));
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A reply cut off by Stop, which pi's TUI marks "Operation aborted" as it ends.
 * Its `errorMessage` is whatever the provider's client threw ("Request aborted",
 * "This operation was aborted", …), so the chat says its own line instead. A
 * tool call it streamed never ran: pi runs no tools after an abort.
 */
export function isAssistantAborted(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "aborted";
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

/** Text, an image, or a tool call is an answer. Thinking alone is not. */
export function hasAssistantAnswer(message: AssistantMessage): boolean {
  return (message.content ?? []).some((block) => {
    if (block.type === "text") return block.text.trim().length > 0;
    return block.type === "image" || block.type === "toolCall";
  });
}

/**
 * How many of a running `!` command's last lines show under its card, and how many rows
 * once wrapped: pi's TUI previews `PREVIEW_LINES` (20) and cuts them to as many visual lines.
 */
export const LIVE_OUTPUT_PREVIEW_LINES = 20;

/** A running `!` command's last lines (`LIVE_OUTPUT_PREVIEW_LINES`); the page caps their rows. */
export function liveOutputPreview(output: string): string {
  return output.replace(/\n+$/, "").split("\n").slice(-LIVE_OUTPUT_PREVIEW_LINES).join("\n");
}

/** The messages' summed `usage.cost.total`, as their usage lines show it; undefined when none costs anything. */
export function sumCost(messages: readonly AgentMessage[]): number | undefined {
  let total = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const cost = message.usage?.cost?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) total += cost;
  }
  return total > 0 ? total : undefined;
}
