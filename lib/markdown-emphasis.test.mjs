import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

import {
  delimiterRunsOfLine,
  describeEmphasisIssue,
  findLeakedMarkers,
  findLineEmphasisIssue,
  flankingOf,
  lintMarkdownDocument,
  locateInSource,
  proseOfRenderedHtml,
} from "./markdown-emphasis.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { markdownRemarkPlugins } = await jiti.import("./markdown.ts");

/**
 * The rule these tests hold the documents to, quoted from CommonMark 0.31.2 §6.5
 * and the GFM spec, which state it identically:
 *
 *   left-flanking  = (1) not followed by Unicode whitespace, and either
 *                    (2a) not followed by punctuation, or
 *                    (2b) followed by punctuation and preceded by whitespace or punctuation
 *   right-flanking = (1) not preceded by Unicode whitespace, and either
 *                    (2a) not preceded by punctuation, or
 *                    (2b) preceded by punctuation and followed by whitespace or punctuation
 *
 *   `**` can open strong emphasis  iff left-flanking
 *   `**` can close strong emphasis iff right-flanking
 *   the beginning and the end of the line count as Unicode whitespace
 *
 * GitHub renders these files with cmark-gfm, so the check is a real CommonMark
 * render rather than a hand-written guess about pairing: a parser that accepted the
 * emphasis leaves no markers behind, and one that refused prints them.
 */

/** CommonMark with no extensions, which is what GitHub does to `**`. */
function strictRender(markdown) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, null, markdown));
}

function lint(markdown) {
  return lintMarkdownDocument(markdown, strictRender);
}

test("flanking: both sides of a word character can open and close", () => {
  const between = flankingOf("开", "下", "**");
  assert.equal(between.canOpen, true);
  assert.equal(between.canClose, true);
});

test("flanking: preceded by punctuation and followed by a word character cannot close", () => {
  // The mistake this exists for: `…全绿。**下面`. U+3002 is category P, so arm (2b)
  // of right-flanking needs whitespace or punctuation after the run and finds a
  // letter. Nothing here is CJK-specific — the ASCII full stop behaves the same.
  const afterFullStop = flankingOf("。", "下", "**");
  assert.equal(afterFullStop.rightFlanking, false);
  assert.equal(afterFullStop.canClose, false);
  assert.equal(flankingOf(".", "n", "**").canClose, false);
});

test("flanking: the same run at line end or before punctuation does close", () => {
  // Line end counts as Unicode whitespace, and punctuation is arm (2b) verbatim.
  assert.equal(flankingOf("。", undefined, "**").canClose, true);
  assert.equal(flankingOf("。", "：", "**").canClose, true);
  assert.equal(flankingOf("。", " ", "**").canClose, true);
});

test("flanking: preceded by a word character and followed by punctuation cannot open", () => {
  // The mirror case, `文**（重点）**字` — why both definitions are checked.
  assert.equal(flankingOf("文", "（", "**").leftFlanking, false);
  assert.equal(flankingOf("文", "（", "**").canOpen, false);
  assert.equal(flankingOf("a", "(", "**").canOpen, false);
});

test("flanking: punctuation on both sides is allowed to do either", () => {
  assert.equal(flankingOf("（", "重", "**").canOpen, true);
  assert.equal(flankingOf("要", "）", "**").canClose, true);
});

test("flanking: the whitespace that matters is the one on the side being judged", () => {
  // Left-flanking is killed by whitespace *after* the run, right-flanking by
  // whitespace *before* it — so a run with a space after it still closes, and one
  // with a space before it still opens.
  const afterSpace = flankingOf("字", " ", "**");
  assert.equal(afterSpace.canOpen, false);
  assert.equal(afterSpace.canClose, true);
  const beforeSpace = flankingOf(" ", "字", "**");
  assert.equal(beforeSpace.canOpen, true);
  assert.equal(beforeSpace.canClose, false);
});

test("flanking: underscores inside a word are never emphasis", () => {
  assert.equal(flankingOf("x", "t", "__").canOpen, false);
  assert.equal(flankingOf("s", "c", "__").canClose, false);
  assert.equal(flankingOf(" ", "b", "__").canOpen, true);
});

test("delimiter runs of a line are reported in order with their verdicts", () => {
  const runs = delimiterRunsOfLine("a **b** c");
  assert.deepEqual(runs.map((run) => run.column), [3, 6]);
  assert.equal(runs[0].flanking.canOpen, true);
  assert.equal(runs[0].flanking.canClose, false);
  assert.equal(runs[1].flanking.canClose, true);
});

test("a bold run that ends on a sentence mark and runs into the next clause is reported", () => {
  const markdown = "- **两种运行器都受支持，并且都必须保持全绿。**真实的 Node.js 上跑 npm test。\n";
  assert.match(strictRender(markdown), /\*\*/, "CommonMark must leave the markers literal");

  const issues = lint(markdown);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].failure, "closes");
  assert.equal(issues[0].line, 1);
  assert.match(describeEmphasisIssue(issues[0]), /cannot close/);
});

test("moving the mark inside the emphasis, or ending the line there, fixes it", () => {
  // Both are real fixes: the closing run is then followed by punctuation, or by
  // line end, which the spec counts as whitespace.
  assert.match(strictRender("- **两种运行器都受支持，并且都必须保持全绿**：真实的 npm runner。\n"), /<strong>/);
  assert.deepEqual(lint("- **两种运行器都受支持，并且都必须保持全绿**：真实的 npm runner。\n"), []);
  assert.deepEqual(lint("- **两种运行器都受支持，并且都必须保持全绿。**\n真实的 npm runner 另起一行。\n"), []);
});

test("the mirror case is reported as a failed open", () => {
  const issues = lint("请打开**（模型）**面板登录。\n");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].failure, "opens");
  assert.equal(issues[0].line, 1);
  assert.match(describeEmphasisIssue(issues[0]), /cannot open/);
});

test("upstream's own README shape is not reported", () => {
  // Two bold runs on one line where the second closer follows another closer: the
  // ordinary case, and the shape a naive pairing check would flag.
  const markdown =
    "- **Two ways to branch**: **New session** creates an independent file; **Edit from here** branches inside it.\n";
  assert.equal(strictRender(markdown).match(/\*\*/g), null);
  assert.deepEqual(lint(markdown), []);
});

test("intended literal markers, code spans and fenced blocks are left alone", () => {
  const markdown = [
    "Match every file with **/*.ts in place of the path.",
    "Write `**粗体。**这样` and it stays literal.",
    "",
    "```md",
    "- **示例。**inside a fence",
    "```",
    "",
    "Configured `max_turns` and `inherit_context` keep their underscores.",
    "",
  ].join("\n");
  assert.deepEqual(lint(markdown), []);
});

test("the application's own renderer is more forgiving, which is why the gate is strict", () => {
  // Model output goes through `remark-cjk-friendly` (`lib/markdown.ts`), and
  // `components/MarkdownBody.test.mjs` pins that `これは**テスト。**テスト` becomes
  // bold there. Repository documents never pass through it, so an author who checks
  // a CJK sentence in the app's preview can still ship a broken page to GitHub.
  const markdown = "これは**テスト。**テスト";
  const inApp = renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: markdownRemarkPlugins }, markdown),
  );
  assert.match(inApp, /<strong>テスト。<\/strong>/, "the app renders it bold, by design");
  assert.equal(
    lintMarkdownDocument(markdown, (source) => renderToStaticMarkup(React.createElement(ReactMarkdown, null, source)))[0]
      .failure,
    "closes",
    "GitHub would print the asterisks",
  );
});

test("helper: rendered code is not prose", () => {
  const html = "<p>see <code>**x**</code></p><pre><code>**y**</code></pre><p>**z。**keep here</p>";
  const stripped = proseOfRenderedHtml(html);
  assert.doesNotMatch(stripped, /\*\*x|\*\*y/);
  // The failed pair leaves both markers spelled out, which is one finding.
  assert.equal(findLeakedMarkers(stripped).length, 2);
});

test("helper: a leaked marker is placed back on its source line and occurrence", () => {
  const line = "请打开**模型（Models）**面板登录。";
  const source = `first line\n${line}\nlast line\n`;
  const columns = delimiterRunsOfLine(line).map((run) => run.column);
  const leaks = findLeakedMarkers(source);
  assert.equal(leaks.length, 2);
  assert.deepEqual(leaks.map((leak) => locateInSource(source, leak)?.line), [2, 2]);
  assert.deepEqual(leaks.map((leak) => locateInSource(source, leak)?.column), columns);
});

test("every Markdown file in this repository renders its emphasis", () => {
  // The subject is the documentation itself: its rendered form is what a reader
  // sees, and a bold run that fails CommonMark's flanking rules shows asterisks.
  //
  // `execFileSync` with an argument array, not a shell string: a shell expands
  // `*.md` against the working directory first and would silently shrink the scan
  // to the files sitting at the repository root.
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.md"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  assert.ok(files.length > 20, `expected the repository's Markdown to be listed, saw ${files.length} files`);

  const problems = files.flatMap((file) => lintMarkdownDocument(readFileSync(file, "utf8"), strictRender, file));
  assert.deepEqual(
    problems.map((issue) => describeEmphasisIssue(issue)),
    [],
  );
});

test("findLineEmphasisIssue: the role a marker was left in decides the verdict", () => {
  // Intended literals: the rules are content with these markers in their roles, so
  // CommonMark printing them is correct, not a document bug.
  assert.equal(findLineEmphasisIssue("Match **/*.ts anywhere in src.", [7]), null);
  assert.equal(findLineEmphasisIssue("Match **/*.ts and **/*.js files.", [7, 19]), null);

  const broken = "- **两种运行器都受支持，并且都必须保持全绿。**真实的 npm runner 是第二意见。";
  const brokenColumns = delimiterRunsOfLine(broken).map((run) => run.column);
  assert.equal(findLineEmphasisIssue(broken, brokenColumns)?.failure, "closes");

  // The mirror shape refuses both roles: nothing on the line could pair with what,
  // which is why reading this as a missing partner missed it.
  const mirror = "请打开**（模型）**面板登录。";
  const mirrorColumns = delimiterRunsOfLine(mirror).map((run) => run.column);
  assert.equal(findLineEmphasisIssue(mirror, mirrorColumns)?.failure, "opens");

  const fixed = "- **两种运行器都受支持，并且都必须保持全绿**：真实的 npm runner 是第二意见。";
  assert.equal(findLineEmphasisIssue(fixed, delimiterRunsOfLine(fixed).map((run) => run.column)), null);
});
