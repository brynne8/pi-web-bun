const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const HTML_TAG = /<[A-Za-z!/?]/;
const INLINE_CODE = /`[^`]*`/g;
// A link reference or footnote definition (`[guide]: https://…`, `[^1]: …`).
const DEFINITION = /^ {0,3}\[[^\]]+\]:/;

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
 * opening with front matter. A definition line outside a fence (`[guide]: …`,
 * `[^1]: …`) keeps the whole message one block, since its references may sit
 * in any other block. A rare miss only makes a block larger
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
      else if (marker === fence.marker && size >= fence.size && /^[ \t]*\r?$/.test(line.slice(fenceMatch[0].length))) fence = null;
    } else if (!fence) {
      // A definition line keeps the whole text one block (see above), and the
      // checkpoint goes back to the start, so the next chunk splits it whole too.
      if (DEFINITION.test(line)) {
        return {
          blocks: [markdown],
          checkpoint: { source: markdown, lineCount: 0, sourceLines: [], blocks: [], current: [], state: initialSplitState },
        };
      }
      const prose = line.replace(INLINE_CODE, "");
      if (HTML_TAG.test(prose)) rawHtml = true;
      if ((prose.match(/\$\$/g)?.length ?? 0) % 2 === 1) inMath = !inMath;
    }
    afterBlank = blank;
  }

  committed.push(current.join("\n"));
  return { blocks: committed, checkpoint };
}

const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;

/**
 * A streaming block that is one fenced code block and nothing else: its
 * language and code, as react-markdown would hand them to the `code`
 * renderer (no trailing newline). A fence still being written has no closing
 * line yet. MarkdownBody renders such a block straight, so a long fence is
 * not run through the markdown parser again on every chunk. Anything else
 * (an indented fence, text after the closing line, a ```math fence, CR line
 * endings, an info string with escapes or entities the parser decodes) is
 * null and parsed as usual.
 */
export function parseFenceBlock(block: string): { lang: string; code: string } | null {
  // The parser takes \r\n and \r as line endings, and decodes `\+` and
  // `&amp;` in the info string.
  if (block.includes("\r")) return null;
  const lines = block.split("\n");
  const open = lines[0].match(FENCE_OPEN);
  if (!open || /[\\&]/.test(open[2])) return null;
  const marker = open[1][0];
  const size = open[1].length;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
    if (fence && fence[1][0] === marker && fence[1].length >= size) { close = i; break; }
  }
  if (close !== -1 && lines.slice(close + 1).some((line) => line.trim() !== "")) return null;
  const lang = open[2].toLowerCase();
  // A math fence is display math (KaTeX, lib/markdown.ts), not code.
  if (lang === "math") return null;
  // A closed fence's code is every line up to the closing one, a blank last
  // line included; an open fence's ends before the block's final line break.
  const end = close !== -1 ? close : lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  return { lang, code: lines.slice(1, end).join("\n") };
}
