/**
 * Rules behind `lib/readme-sync.test.mjs`: what a translated README must keep in
 * step with the English one, and how a Markdown link is resolved. Pure string
 * work — the test owns the file reads.
 */

export interface MarkdownLine {
  /** The line with code spans blanked, for reading links and list markers. */
  text: string;
  /** The line with code-span backticks dropped and their text kept, for headings. */
  plain: string;
  /** True inside a fenced block, where nothing is structure. */
  fenced: boolean;
  line: number;
}

export interface MarkdownHeading {
  level: number;
  title: string;
  slug: string;
  line: number;
}

/** One section of one heading level; a deeper heading stays inside it. */
export interface MarkdownSection {
  level: number;
  title: string;
  slug: string;
  line: number;
  /** `- ` list items, outside fences. */
  bullets: number;
  /** `**Bold claim.**` paragraphs, outside fences. */
  entries: number;
}

export interface MarkdownLink {
  /** The path part, or "" for a same-document link. */
  target: string;
  fragment: string | null;
  line: number;
}

/** A `**claim**` paragraph with the documents it points at. */
export interface MarkdownEntry {
  title: string;
  /** Each relative link as `basename#fragment`, so a translated path prefix matches. */
  notes: string[];
  line: number;
}

/** GitHub's anchor for a heading: lowercase, punctuation gone, every space a hyphen. */
export function githubSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- _]/gu, "")
    .replace(/ /g, "-");
}

/**
 * Lines with fenced blocks dropped and code spans blanked, so a `## ` inside an
 * example or a `](x)` inside a code span is never read as structure. `plain` keeps
 * a code span's text, because a heading's anchor contains it. `line` stays the
 * 1-based number in the document.
 */
export function markdownLines(markdown: string): MarkdownLine[] {
  const out: MarkdownLine[] = [];
  let fence: string | null = null;
  const raw = markdown.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const opens = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && opens) {
      fence = opens[1][0].repeat(3);
      out.push({ text: "", plain: "", fenced: true, line: i + 1 });
      continue;
    }
    if (fence !== null) {
      if (line.trim().startsWith(fence)) fence = null;
      out.push({ text: "", plain: "", fenced: true, line: i + 1 });
      continue;
    }
    out.push({
      text: line.replace(/`[^`]*`/g, "\u0000"),
      plain: line.replace(/`([^`]*)`/g, "$1"),
      fenced: false,
      line: i + 1,
    });
  }
  return out;
}

export function headingsOf(markdown: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  for (const { plain, line } of markdownLines(markdown)) {
    const match = /^(#{1,6})\s+(.*)$/.exec(plain);
    if (!match) continue;
    const title = match[2].trim();
    out.push({ level: match[1].length, title, slug: githubSlug(title), line });
  }
  return out;
}

/** Sections of one heading level; a deeper heading stays inside its section. */
export function sectionsOf(markdown: string, level = 2): MarkdownSection[] {
  const marks: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  for (const { text, plain, line } of markdownLines(markdown)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(plain);
    if (heading) {
      const depth = heading[1].length;
      if (depth < level) current = null;
      if (depth !== level) continue;
      const title = heading[2].trim();
      current = { level, title, slug: githubSlug(title), line, bullets: 0, entries: 0 };
      marks.push(current);
      continue;
    }
    if (!current) continue;
    if (/^- /.test(text)) current.bullets++;
    if (/^\*\*/.test(text)) current.entries++;
  }
  return marks;
}

/** Relative links only: an absolute URL is nobody's business here. */
export function relativeLinksOf(markdown: string): MarkdownLink[] {
  const out: MarkdownLink[] = [];
  for (const { text, line } of markdownLines(markdown)) {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) continue;
      const [target, fragment] = href.split("#");
      out.push({ target, fragment: fragment ? fragment : null, line });
    }
  }
  return out;
}

/** The document's claims, in document order, identified by the notes they link. */
export function entriesOf(markdown: string): MarkdownEntry[] {
  const out: MarkdownEntry[] = [];
  let current: MarkdownEntry | null = null;
  for (const { text, plain, line } of markdownLines(markdown)) {
    const title = /^\*\*([^*]+)\*\*/.exec(plain);
    if (title) {
      if (current) out.push(current);
      current = { title: title[1], notes: [], line };
    }
    if (!current) continue;
    for (const link of relativeLinksOf(text)) {
      const base = link.target.split("/").pop() ?? link.target;
      current.notes.push(link.fragment ? `${base}#${link.fragment}` : base);
    }
    if (text.trim() === "") {
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.filter((entry) => entry.notes.length > 0);
}
