import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "./types";
import { isEmptyThinkingBlock, isHiddenCustomMessage } from "./message-display";

/**
 * A turn as the chat should show it: everything the model wrote stays on the
 * screen, and each run of thinking and tool calls between those words becomes
 * one collapsed group of its own.
 *
 * The old view kept one group holding everything up to the turn's last tool
 * call, so the sentences the model wrote while working — often the useful ones —
 * were hidden behind a fold whose label said "messages". Segmenting instead of
 * splitting keeps the fold where it belongs (on the noise) and puts the words
 * where they were written.
 */

/** One piece of a turn: a stored message and the block range of it this piece carries. */
export interface TurnPart {
  /** Index into the message array passed to `splitTurnSegments`. */
  index: number;
  /** First stored block index the part carries, so a deferred thinking keeps the index it was stored under. */
  start: number;
  /** One past the last stored block index. */
  end: number;
  /** A custom message: it carries no blocks and needs no offset. */
  custom: boolean;
}

export interface TurnSegment {
  /** `answer` is the model's own output; `process` is what it did to get there. */
  kind: "answer" | "process";
  parts: TurnPart[];
  /** Stored messages in the segment, for the group's "N messages". */
  messageCount: number;
  toolCallCount: number;
}

/**
 * What reads as the turn's output rather than as its workings: text the model
 * wrote and an image it returned.
 */
function isOutputBlock(block: AssistantContentBlock): boolean {
  if (block.type === "image") return true;
  return block.type === "text" && block.text.trim().length > 0;
}

/**
 * A block that renders nothing: empty thinking once the turn is finished, and a
 * text block of only whitespace. Neither may open a segment — a group holding
 * nothing, or an answer of nothing, is a control the user has to reason about
 * for no information.
 */
function rendersNothing(block: AssistantContentBlock): boolean {
  if (isEmptyThinkingBlock(block)) return true;
  return block.type === "text" && block.text.trim().length === 0;
}

function countToolCalls(blocks: AssistantContentBlock[], start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index++) {
    if (blocks[index]?.type === "toolCall") count += 1;
  }
  return count;
}

/**
 * The turn's messages, in order, as segments to render. Consecutive pieces of
 * the same kind merge, so thinking and tool calls spanning several stored
 * messages — one assistant entry per tool call — form a single group, and the
 * words in between each get their own place on screen.
 *
 * A displayed custom message belongs with the workings around it, so it joins
 * the group it follows and opens one when it comes right after an answer. A
 * message with nothing to show contributes nothing.
 */
export function splitTurnSegments(messages: AgentMessage[], from: number, to: number): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let current: TurnSegment | null = null;

  const segmentFor = (kind: TurnSegment["kind"]): TurnSegment => {
    if (current?.kind === kind) return current;
    const started: TurnSegment = { kind, parts: [], messageCount: 0, toolCallCount: 0 };
    segments.push(started);
    current = started;
    return started;
  };

  const add = (kind: TurnSegment["kind"], part: TurnPart, toolCalls: number) => {
    const segment = segmentFor(kind);
    const previous = segment.parts[segment.parts.length - 1];
    if (previous && previous.index === part.index && previous.end === part.start && !part.custom) {
      previous.end = part.end;
      segment.toolCallCount += toolCalls;
      return;
    }
    segment.parts.push(part);
    segment.messageCount += 1;
    segment.toolCallCount += toolCalls;
  };

  for (let index = from; index < to; index++) {
    const message = messages[index];
    if (!message) continue;

    if (message.role === "custom") {
      if (isHiddenCustomMessage(message)) continue;
      // Its own part: a custom message has no blocks to carry.
      const segment = segmentFor("process");
      if (!segment.parts.some((part) => part.index === index && part.custom)) {
        segment.parts.push({ index, start: -1, end: -1, custom: true });
        segment.messageCount += 1;
      }
      continue;
    }

    if (message.role !== "assistant") continue;
    const blocks = ((message as AssistantMessage).content ?? []) as AssistantContentBlock[];

    let runStart = -1;
    let runKind: TurnSegment["kind"] | null = null;
    const flush = (end: number) => {
      if (runStart < 0 || runKind === null) return;
      add(runKind, { index, start: runStart, end, custom: false }, countToolCalls(blocks, runStart, end));
      runStart = -1;
      runKind = null;
    };

    for (let block = 0; block < blocks.length; block++) {
      const entry = blocks[block];
      if (!entry || rendersNothing(entry)) continue;
      const kind = isOutputBlock(entry) ? "answer" : "process";
      if (runKind === null) {
        runKind = kind;
        runStart = block;
      } else if (kind !== runKind) {
        flush(block);
        runKind = kind;
        runStart = block;
      }
    }
    flush(blocks.length);
  }

  return segments;
}

/** Whether a turn has output to show, which decides how its last group starts. */
export function turnHasAnswer(segments: TurnSegment[]): boolean {
  return segments.some((segment) => segment.kind === "answer");
}
