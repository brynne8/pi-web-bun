const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_TAG = /<[A-Za-z!/?]/;
const INLINE_CODE = /`[^`]*`/g;

interface SplitState {
  fence: { marker: string; size: number } | null;
  inMath: boolean;
  rawHtml: boolean;
  afterBlank: boolean;
}

const initialSplitState: SplitState = { fence: null, inMath: false, rawHtml: false, afterBlank: false };

/**
 * Where a growing text resumes splitting: `blocks` and `current` hold the first
 * `lineCount` input lines, `sourceLines` those lines themselves and `state` the
 * splitter state at the start of that line, so splitting from there gives the
 * whole text's blocks. The last line is never committed, because it is still
 * growing.
 */
export interface BlockSplitCheckpoint {
  source: string;
  lineCount: number;
  sourceLines: string[];
  blocks: string[];
  current: string[];
  state: SplitState;
}

export interface MarkdownBlockSplit {
  blocks: string[];
  checkpoint: BlockSplitCheckpoint;
}

/**
 * Splits markdown before top-level blocks that cannot belong to the block
 * above, so a streaming message renders block by block: finished blocks keep
 * their parse and only the last one is parsed again as text arrives (one parse
 * of the whole reply per chunk made a long reply quadratic). The pieces join
 * back to the input.
 *
 * A split goes only after a blank line, before a line that starts at column 0
 * and is not a list item: never inside a code fence or a `$$` math block,
 * never inside a loose list or an indented continuation. Raw HTML may wrap
 * blank lines (`<details>`, an inline `<b>` left open), so nothing after the
 * first line with a tag outside inline code is split, nor is a document
 * opening with front matter. A rare miss only makes a block larger
 * or, at worst, renders one transiently apart while streaming: the finished
 * message is rendered whole.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
  return splitMarkdownBlocksIncremental(markdown, null).blocks;
}

function samePrefixLines(lines: string[], expected: string[], count: number): boolean {
  if (count >= lines.length) return false;
  for (let index = 0; index < count; index++) {
    if (lines[index] !== expected[index]) return false;
  }
  return true;
}

function resumableSplit(
  previous: BlockSplitCheckpoint | null,
  lines: string[],
): { lineCount: number; blocks: string[]; current: string[]; state: SplitState } {
  // The committed lines are all a resume needs: the text after them is read again
  // either way, so a chunk that keeps the prefix resumes exactly as one that
  // extends it does.
  if (previous && samePrefixLines(lines, previous.sourceLines, previous.lineCount)) {
    return {
      lineCount: previous.lineCount,
      blocks: previous.blocks,
      current: previous.current,
      state: previous.state,
    };
  }
  return { lineCount: 0, blocks: [], current: [], state: initialSplitState };
}

/**
 * `splitMarkdownBlocks` for a text that only grows: the blocks the previous
 * checkpoint committed keep their cut and only the rest is scanned again. A
 * chunk that does not keep that prefix (an authoritative replacement) is split
 * whole, as a finished message is.
 */
export function splitMarkdownBlocksIncremental(
  markdown: string,
  previous: BlockSplitCheckpoint | null,
): MarkdownBlockSplit {
  const lines = markdown.split("\n");
  const resume = resumableSplit(previous, lines);
  const committed = resume.blocks.slice();
  const current = resume.current.slice();
  let fence = resume.state.fence;
  let inMath = resume.state.inMath;
  let rawHtml = resume.state.rawHtml;
  let afterBlank = resume.state.afterBlank;
  // Front matter opens a document that is never cut; a growing one keeps the
  // state the first pass left behind. The first line only counts once it is
  // complete: a line that starts as `---` and keeps growing is not front matter.
  if (resume.lineCount === 0 && lines.length > 1 && /^---[ \t]*\r?$/.test(lines[0])) rawHtml = true;
  const last = lines.length - 1;
  let checkpoint: BlockSplitCheckpoint = {
    source: markdown,
    lineCount: resume.lineCount,
    sourceLines: lines.slice(0, resume.lineCount),
    blocks: committed.slice(),
    current: current.slice(),
    state: { ...resume.state },
  };

  for (let index = resume.lineCount; index < lines.length; index++) {
    const line = lines[index];
    if (index === last) {
      checkpoint = {
        source: markdown,
        lineCount: index,
        sourceLines: lines.slice(0, index),
        blocks: committed.slice(),
        current: current.slice(),
        state: { fence, inMath, rawHtml, afterBlank },
      };
    }

    const blank = line.trim() === "";
    if (afterBlank && !blank && !fence && !inMath && !rawHtml && current.length > 0
      && !/^[ \t]/.test(line) && !LIST_ITEM.test(line)) {
      committed.push(current.join("\n") + "\n");
      current.length = 0;
    }
    current.push(line);

    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      const size = fenceMatch[1].length;
      if (!fence) fence = { marker, size };
      else if (marker === fence.marker && size >= fence.size) fence = null;
    } else if (!fence) {
      const prose = line.replace(INLINE_CODE, "");
      if (HTML_TAG.test(prose)) rawHtml = true;
      if ((prose.match(/\$\$/g)?.length ?? 0) % 2 === 1) inMath = !inMath;
    }
    afterBlank = blank;
  }

  committed.push(current.join("\n"));
  return { blocks: committed, checkpoint };
}
