import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { entriesOf, githubSlug, headingsOf, markdownLines, relativeLinksOf, sectionsOf } = await jiti.import("./readme-sync.ts");

/** The English README and the copy that this fork keeps translated. */
const ENGLISH = "README.md";
const CHINESE = "docs/README.zh-CN.md";

function read(file) {
  // Read with "\n": a Windows checkout has CRLF on disk (core.autocrlf, no
  // .gitattributes), and a line ending in CR matches neither the heading nor the
  // bold-claim pattern, so every anchor would be reported as naming no heading.
  return readFileSync(file, "utf8").replaceAll("\r\n", "\n");
}

/** Repository Markdown, from git so a glob cannot shrink the scan to the root. */
function repositoryMarkdown() {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 20, `expected the repository's Markdown to be listed, saw ${files.length} files`);
  return files;
}

test("slug: a heading's punctuation goes and every space becomes a hyphen", () => {
  // GitHub keeps a space that sat beside removed punctuation, which is why
  // "Settings › Tools" is `#settings--tools` with two hyphens.
  assert.equal(githubSlug("Settings › Tools"), "settings--tools");
  assert.equal(githubSlug("The read-out (`components/ActivityDiagnostics.tsx`)"), "the-read-out-componentsactivitydiagnosticstsx");
  assert.equal(githubSlug("与原版的区别"), "与原版的区别");
  assert.equal(githubSlug("A file row's own menu"), "a-file-rows-own-menu");
});

test("lines: fenced blocks and code spans carry no structure, and line numbers survive", () => {
  const lines = markdownLines(["# real", "```md", "# not a heading", "```", "Text with `](fake.md)` inside."].join("\n"));
  assert.deepEqual(
    lines.map((l) => [l.line, l.fenced]),
    [
      [1, false],
      [2, true],
      [3, true],
      [4, true],
      [5, false],
    ],
  );
  assert.equal(headingsOf(["# real", "```md", "# not a heading", "```"].join("\n")).length, 1);
  assert.deepEqual(relativeLinksOf(lines.at(-1).text), []);
  // The heading's anchor keeps a code span's words, so the two views of a line differ.
  const heading = markdownLines("## The read-out (`components/ActivityDiagnostics.tsx`)").at(0);
  assert.match(heading.text, /\u0000/);
  assert.equal(headingsOf("## The read-out (`components/ActivityDiagnostics.tsx`)")[0].slug, "the-read-out-componentsactivitydiagnosticstsx");
});

test("sections: a deeper heading stays inside its section, the same level closes it", () => {
  const markdown = [
    "## One",
    "- a",
    "- b",
    "",
    "### Deeper",
    "- c",
    "**A claim.** text ([Note](./agents/x.md#s))",
    "",
    "## Two",
    "- d",
    "",
    "# A document",
    "- outside",
  ].join("\n");
  const sections = sectionsOf(markdown, 2);
  assert.deepEqual(
    sections.map((s) => [s.title, s.bullets, s.entries]),
    [
      ["One", 3, 1],
      ["Two", 1, 0],
    ],
  );
});

test("entries: a claim is known by the notes it links, whatever the path prefix", () => {
  const english = "**A claim.** text ([Note](./docs/agents/sessions.md#a-b)) and ([#12](https://github.com/agegr/pi-web/pull/12)).\n\nplain text ([x](./other.md))\n";
  const chinese = "**一个说法。** 正文（[说明](./agents/sessions.md#a-b)）。\n\n普通文字（[x](./other.md)）\n";
  const en = entriesOf(english);
  const zh = entriesOf(chinese);
  // The upstream PR link is an absolute URL, so it cannot tell the two copies apart;
  // the note can, once its directory prefix comes off.
  assert.deepEqual(en.map((e) => [e.title, e.notes]), [["A claim.", ["sessions.md#a-b"]]]);
  assert.deepEqual(
    zh.map((e) => e.notes),
    en.map((e) => e.notes),
  );
  // A paragraph nobody bolded is prose, and a bold claim with no note names no
  // document to compare, so neither is an entry.
  assert.deepEqual(entriesOf("plain text ([x](./other.md))\n"), []);
  assert.deepEqual(entriesOf("**A claim with no note.** text\n"), []);
});

test("the Chinese README holds the same sections as the English one", () => {
  // A section translated away is a section nobody notices going missing, so the
  // two copies are compared where counting works: the same sections, in the same
  // order, holding the same number of list items and claims. Titles are translated,
  // so they are never compared.
  const pairs = [ENGLISH, CHINESE].map((file) => ({
    file,
    level2: sectionsOf(read(file), 2),
    level3: sectionsOf(read(file), 3),
  }));
  const [en, zh] = pairs;
  assert.equal(
    zh.level2.length,
    en.level2.length,
    `section count differs: ${en.level2.map((s) => s.title).join(", ")} | ${zh.level2.map((s) => s.title).join(", ")}`,
  );
  assert.equal(zh.level3.length, en.level3.length, "subsection count differs between the two READMEs");
  const problems = en.level2.flatMap((section, i) => {
    const other = zh.level2[i];
    const out = [];
    if (section.bullets !== other.bullets) {
      out.push(`${en.file}#${section.slug} holds ${section.bullets} list items, ${zh.file}#${other.slug} holds ${other.bullets}`);
    }
    if (section.entries !== other.entries) {
      out.push(`${en.file}#${section.slug} holds ${section.entries} bold claims, ${zh.file}#${other.slug} holds ${other.entries}`);
    }
    return out;
  });
  assert.deepEqual(problems, []);
});

test("the Chinese README holds the same claims in the same order", () => {
  // The claim this fork adds is identified by the note it links, not by its
  // sentence: an entry deleted here but not there (upstream taking the feature),
  // or one never translated, shows up as a position where the two notes differ.
  const en = entriesOf(read(ENGLISH));
  const zh = entriesOf(read(CHINESE));
  assert.equal(zh.length, en.length, "claim count differs between the two READMEs");
  const problems = en.flatMap((entry, i) =>
    entry.notes.join(",") === zh[i].notes.join(",")
      ? []
      : [
          `#${i + 1} ${en.file}:${entry.line} "${entry.title}" links ${entry.notes.join(", ") || "nothing"}; ` +
            `${zh.file}:${zh[i].line} "${zh[i].title}" links ${zh[i].notes.join(", ") || "nothing"}`,
        ],
  );
  assert.deepEqual(problems, []);
});

test("every relative link in the repository's Markdown resolves", () => {
  // A link is how a reader reaches the note behind a claim, and a translated copy
  // sits one directory deeper: `./docs/agents/x.md` here is `./agents/x.md` there,
  // and `./README.md` in `docs/` reaches nothing.
  const problems = [];
  for (const file of repositoryMarkdown()) {
    const headings = headingsOf(read(file));
    const cache = new Map();
    for (const link of relativeLinksOf(read(file))) {
      if (!link.target) {
        if (link.fragment && !headings.some((h) => h.slug === link.fragment)) {
          problems.push(`${file}:${link.line} #${link.fragment} names no heading of its own`);
        }
        continue;
      }
      const target = resolve(dirname(file), link.target);
      if (!target.startsWith(process.cwd())) continue;
      if (!existsSync(target)) {
        problems.push(`${file}:${link.line} ${link.target} does not exist`);
        continue;
      }
      if (!link.fragment || !target.endsWith(".md")) continue;
      if (!cache.has(target)) cache.set(target, headingsOf(read(target)));
      if (!cache.get(target).some((h) => h.slug === link.fragment)) {
        problems.push(`${file}:${link.line} ${relative(process.cwd(), target)}#${link.fragment} names no heading`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("a section heading is the only one of that name where documents link by name", () => {
  // A repeated heading resolves to the first anchor, so a link can name one
  // section and land in its twin — which is how a merge that left two copies of
  // one section in a note passed every link check.
  //
  // A note's headings are names: the READMEs and the other notes point at them,
  // so every repeat is refused there. Outside `docs/agents/` a heading is a name
  // only while something links it, so a document may repeat one — `docs/release.md`
  // has `## 中文` twice, once per release-notes template.
  const duplicatedAnchors = (file) => {
    const counts = new Map();
    for (const heading of headingsOf(read(file))) {
      const key = `${heading.level}|${heading.slug}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts].filter(([, count]) => count > 1).map(([key, count]) => [key.split("|")[1], count]);
  };

  const linked = new Map();
  for (const file of repositoryMarkdown()) {
    for (const link of relativeLinksOf(read(file))) {
      if (!link.fragment || !link.target.endsWith(".md")) continue;
      const target = relative(process.cwd(), resolve(dirname(file), link.target));
      if (!target.endsWith(".md") || !existsSync(target)) continue;
      if (!linked.has(target)) linked.set(target, new Set());
      linked.get(target).add(link.fragment);
    }
  }

  const problems = [];
  for (const file of repositoryMarkdown()) {
    const duplicates = duplicatedAnchors(file);
    if (file.startsWith("docs/agents/")) {
      problems.push(...duplicates.map(([fragment, count]) => `${file} has ${count} headings anchored #${fragment}`));
      continue;
    }
    const wanted = linked.get(file);
    if (!wanted) continue;
    problems.push(
      ...duplicates
        .filter(([fragment]) => wanted.has(fragment))
        .map(([fragment, count]) => `${file} has ${count} headings anchored #${fragment}, which other documents link`),
    );
  }
  assert.deepEqual(problems, []);
});
