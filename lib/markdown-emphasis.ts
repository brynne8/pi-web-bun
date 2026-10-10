/**
 * CommonMark/GFM emphasis flanking, for the test that keeps our own Markdown free
 * of literal `**`. From CommonMark 0.31.2 §6.5 and the GFM spec, which agree:
 *
 *   left-flanking  — not followed by whitespace; when followed by punctuation,
 *                    preceded by whitespace or punctuation.
 *   right-flanking — not preceded by whitespace; when preceded by punctuation,
 *                    followed by whitespace or punctuation.
 *   Line ends count as whitespace. `**` opens iff left-flanking, closes iff
 *   right-flanking; `_` adds the intraword rule.
 *
 * So `**全绿。**下面` closes nothing — punctuation before, a letter after — while the
 * same run at a line end is fine. The app forgives that shape through
 * `remark-cjk-friendly`; GitHub does not, so the check is the strict one.
 */

/** Unicode punctuation as the spec defines it: category P, plus ASCII marks. */
const isPunctuation = (character: string | undefined): boolean =>
  character !== undefined &&
  (/\p{P}/u.test(character) || /[!"#%&'()*,\-./:;<=>?@[\\\]^_`{|}~]/u.test(character));

/** CommonMark whitespace: space, tab, line feed, form feed, carriage return. */
const isWhitespace = (character: string | undefined): boolean =>
  character === undefined || character === " " || character === "\t" || character === "\n" || character === "\f" || character === "\r";

const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

export interface Flanking {
  leftFlanking: boolean;
  rightFlanking: boolean;
  canOpen: boolean;
  canClose: boolean;
}

/**
 * The spec's verdict for one delimiter run. `before` and `after` are the characters
 * outside it; `undefined` is a line end, which counts as whitespace.
 */
export function flankingOf(before: string | undefined, after: string | undefined, marker: string): Flanking {
  const leftFlanking =
    !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const rightFlanking =
    !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));

  if (marker.startsWith("_")) {
    const intraword = isWordCharacter(before) && isWordCharacter(after);
    return {
      leftFlanking,
      rightFlanking,
      canOpen: leftFlanking && (!rightFlanking || isPunctuation(before)),
      canClose: rightFlanking && (!leftFlanking || isPunctuation(after)) && !intraword,
    };
  }
  return { leftFlanking, rightFlanking, canOpen: leftFlanking, canClose: rightFlanking };
}

interface DelimiterRun {
  marker: string;
  /** 1-based. */
  column: number;
  flanking: Flanking;
}

/** Every `*` or `_` delimiter run on a single line, with its flanking verdict. */
export function delimiterRunsOfLine(line: string): DelimiterRun[] {
  const runs: DelimiterRun[] = [];
  const pattern = /(\*+|_+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const marker = match[0];
    const before = match.index === 0 ? " " : line[match.index - 1];
    const after = line[match.index + marker.length];
    runs.push({ marker, column: match.index + 1, flanking: flankingOf(before, after, marker) });
  }
  return runs;
}

export type FlankingFailure = "opens" | "closes" | "both";

/** A glob marker, which was never meant to be emphasis: `**` followed by a slash. */
const isGlobMarker = (line: string, column: number, marker: string): boolean =>
  line[column - 1 + marker.length] === "/";

/**
 * Which role the specification refused on a line. Markers left in prose come from
 * one pair attempt, so their roles alternate — open, close, open — and no partner
 * search is needed, which `请打开**（模型）**面板登录。` would defeat by refusing both
 * roles. A marker its role allows was meant to be literal, so it is not a finding.
 */
export function findLineEmphasisIssue(line: string, leakedColumns: number[]): { column: number; failure: FlankingFailure } | null {
  const runs = delimiterRunsOfLine(line);
  let role: "opens" | "closes" = "opens";

  for (const column of [...leakedColumns].sort((a, b) => a - b)) {
    const run = runs.find((candidate) => candidate.column === column);
    if (!run) continue;
    const refused = role === "opens" ? !run.flanking.canOpen : !run.flanking.canClose;
    if (refused && !isGlobMarker(line, column, run.marker)) {
      const otherRefused = role === "opens" ? !run.flanking.canClose : !run.flanking.canOpen;
      return { column, failure: otherRefused ? "both" : role };
    }
    role = role === "opens" ? "closes" : "opens";
  }
  return null;
}

/** Rendered prose: markup and entities gone, code dropped — a marker inside
 * `<code>` was meant to be literal, one in prose is the finding. */
export function proseOfRenderedHtml(html: string): string {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<code[\s\S]*?<\/code>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export interface LeakedMarker {
  marker: string;
  /** Which occurrence of `marker` this is within the surrounding window. */
  nth: number;
  /** Text immediately before it, back to the previous marker — the locator's anchor. */
  before: string;
  /** Text immediately after it. */
  after: string;
  /** Surrounding rendered text, for the assertion message. */
  context: string;
}

/**
 * Markers the parser left behind, in document order, each carrying the text up to
 * the previous occurrence: a window around the second marker of a failed pair also
 * holds the first, so anchoring on "the first marker in the window" would put both
 * leaks on the same column.
 */
export function findLeakedMarkers(rendered: string): LeakedMarker[] {
  const found: LeakedMarker[] = [];
  const pattern = /(\*\*+|__+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rendered))) {
    const index = match.index;
    const marker = match[0];
    // Anchors stay on the rendered line: a newline is never inside a source line.
    const lineStart = rendered.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
    const nextBreak = rendered.indexOf("\n", index);
    const lineEnd = nextBreak < 0 ? rendered.length : nextBreak;
    const window = rendered.slice(lineStart, index).slice(-40);
    const afterWindow = rendered.slice(index + marker.length, Math.min(lineEnd, index + marker.length + 20));
    const previousAt = window.lastIndexOf(marker);
    found.push({
      marker,
      nth: window.split(marker).length - 1,
      before: window.slice(previousAt + (previousAt < 0 ? 0 : marker.length)).slice(-10),
      after: afterWindow.slice(0, 10),
      context: window.slice(Math.max(0, window.length - 16)) + marker + afterWindow,
    });
  }
  return found;
}

export interface SourcePlace {
  /** 1-based. */
  line: number;
  /** 1-based, at the marker. */
  column: number;
  text: string;
}

/** Place a leaked marker on a source line by the text around it, trying its
 * occurrence index first and any fitting occurrence after that, because a finding
 * must not be lost to placement. */
export function locateInSource(source: string, leak: LeakedMarker): SourcePlace | null {
  const { marker, nth, before, after } = leak;
  const fits = (line: string, at: number): boolean => {
    const beforeOk = before === "" || line.slice(Math.max(0, at - before.length), at) === before;
    const afterOk = after === "" || line.slice(at + marker.length, at + marker.length + after.length) === after;
    return beforeOk && afterOk;
  };
  const occurrencesOf = (line: string): number[] => {
    const at: number[] = [];
    let index = line.indexOf(marker);
    while (index >= 0) {
      at.push(index);
      index = line.indexOf(marker, index + marker.length);
    }
    return at;
  };

  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const occurrences = occurrencesOf(lines[index]);
    if (occurrences[nth] !== undefined && fits(lines[index], occurrences[nth])) {
      return { line: index + 1, column: occurrences[nth] + 1, text: lines[index] };
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const at = occurrencesOf(lines[index]).find((offset) => fits(lines[index], offset));
    if (at !== undefined) return { line: index + 1, column: at + 1, text: lines[index] };
  }
  return null;
}

export interface EmphasisIssue {
  file?: string;
  line: number;
  column: number;
  marker: string;
  failure: FlankingFailure;
  /** The document's own line, for the assertion message. */
  source: string;
}

/**
 * Render a document and report the markers the prose kept, as far as the flanking
 * rules explain them. `render` is injected to keep this module React-free.
 */
export function lintMarkdownDocument(source: string, render: (markdown: string) => string, file?: string): EmphasisIssue[] {
  const rendered = proseOfRenderedHtml(render(source));
  const issues: EmphasisIssue[] = [];
  const reported = new Set<number>();
  const leakedByLine = new Map<number, number[]>();
  const unplaced: string[] = [];

  for (const leak of findLeakedMarkers(rendered)) {
    const place = locateInSource(source, leak);
    if (!place) {
      unplaced.push(leak.context);
      continue;
    }
    const columns = leakedByLine.get(place.line) ?? [];
    if (!columns.includes(place.column)) columns.push(place.column);
    leakedByLine.set(place.line, columns);
  }

  for (const [line, columns] of leakedByLine) {
    const failure = findLineEmphasisIssue(source.split("\n")[line - 1] ?? "", columns);
    if (!failure || reported.has(line)) continue;
    reported.add(line);
    issues.push({
      file,
      line,
      column: failure.column,
      marker: (source.split("\n")[line - 1] ?? "").slice(failure.column - 1).match(/^[*_]+/)?.[0] ?? "**",
      failure: failure.failure,
      source: source.split("\n")[line - 1] ?? "",
    });
  }

  for (const context of unplaced) {
    // A marker that cannot be placed is still a finding; silence ships the bug.
    issues.push({ file, line: 0, column: 0, marker: "**", failure: "both", source: context });
  }

  return issues;
}

/** One line of an assertion message. */
export function describeEmphasisIssue(issue: EmphasisIssue): string {
  const reason =
    issue.failure === "closes"
      ? "cannot close: preceded by punctuation and followed by a non-punctuation character"
      : issue.failure === "opens"
        ? "cannot open: preceded by a non-punctuation character and followed by punctuation"
        : "can neither open nor close";
  const where = issue.line > 0 ? `${issue.file ?? "document"}:${issue.line}:${issue.column}` : `${issue.file ?? "document"}: (line not found)`;
  return `${where} (${issue.marker} ${reason})  ${issue.source.trim()}`;
}
