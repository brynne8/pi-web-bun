/**
 * Thinking arrives one chunk at a time, and rendering every chunk makes a long
 * thought flicker: the last paragraph is re-parsed as markdown on each update,
 * and a paragraph cut in half renders its unclosed `**` or its half-written
 * list item as though that were the text.
 *
 * So a streaming thought is released a paragraph at a time: everything up to
 * the last blank line shows, the rest waits. A block that is no longer
 * streaming releases all of it, so nothing is ever lost — only held back by one
 * paragraph.
 *
 * Measured over 36k real thinking blocks: 75% contain a paragraph break, and
 * those hold 97.8% of all thinking characters. The 25% without one are short
 * (median 93 characters), so the wait for those is about a second.
 */

/** How much of the raw thinking text has been released so far. */
export interface ThinkingFlushCheckpoint {
  released: number;
}

/** A code fence's opening or closing line: up to three spaces, then ``` or ~~~. */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Index just past the last blank line outside a fenced block, or -1 when there is none.
 *
 * A blank line inside a fence is the code's own, not the prose's: releasing there would
 * show a half-written fence and its body as text while the command is still writing it.
 */
function lastParagraphBreakEnd(text: string): number {
  let end = -1;
  let fenceChar: string | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      // The same character opens and closes, so a ``` block is closed by ``` and not by ~~~.
      if (fenceChar === null) fenceChar = fence[1][0];
      else if (fence[1][0] === fenceChar) fenceChar = null;
    } else if (fenceChar === null && line.trim() === "" && newline !== -1) {
      // Just past the blank line itself: the paragraph above it is finished. A blank line the
      // text ends on is not one yet — the line it would end may still be being written.
      end = lineEnd + 1;
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return end;
}

export interface ThinkingFlushResult {
  /** The text to render. */
  text: string;
  checkpoint: ThinkingFlushCheckpoint;
}

/**
 * The slice of `raw` a thinking block may show, and the checkpoint to pass back
 * on the next call. `released` only ever grows while the text grows, so a chunk
 * that adds nothing to a finished paragraph leaves the rendered text alone.
 *
 * A text shorter than what was released is a replacement rather than a growth
 * (an authoritative re-send), so the count restarts instead of clamping to a
 * length the new text does not have.
 */
export function resolveThinkingVisibleText(
  raw: string,
  isStreaming: boolean,
  previous: ThinkingFlushCheckpoint | null,
): ThinkingFlushResult {
  if (!isStreaming) {
    return { text: raw, checkpoint: { released: raw.length } };
  }
  const released = previous !== null && previous.released <= raw.length ? previous.released : 0;
  const breakEnd = lastParagraphBreakEnd(raw);
  const next = breakEnd > released ? breakEnd : released;
  return { text: raw.slice(0, next), checkpoint: { released: next } };
}
