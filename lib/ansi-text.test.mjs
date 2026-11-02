import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ansi256, hasAnsi, parseAnsiRuns } = await jiti.import("./ansi-text.ts");

/** The visible text of every run, glued back together. */
const plain = (runs) => runs.map((run) => run.text).join("");
const styled = (runs) => runs.filter((run) => run.style);

test("text without escapes is one plain run", () => {
  const runs = parseAnsiRuns("hello world");
  assert.deepEqual(runs, [{ text: "hello world" }]);
  assert.equal(hasAnsi("hello world"), false);
});

test("a foreground colour is its own run and the reset ends it", () => {
  const runs = parseAnsiRuns("\x1b[31mred\x1b[0m tail");
  assert.equal(plain(runs), "red tail");
  assert.deepEqual(styled(runs).map((run) => [run.text, run.style.color]), [
    ["red", ansi256(1)],
  ]);
});

test("bun test's inverse video becomes a chip, not letters", () => {
  const runs = parseAnsiRuns("\x1b[7mError:\x1b[0m none");
  const [error] = styled(runs);
  assert.equal(error.text, "Error:");
  assert.match(error.style.background, /--ansi-fg/);
  assert.match(error.style.color, /--ansi-bg/);
  assert.equal(styled(runs).length, 1);
});

test("inverse over a colour swaps it onto the background", () => {
  const [run] = styled(parseAnsiRuns("\x1b[31;7mwarn\x1b[27m plain"));
  assert.equal(run.style.background, ansi256(1));
  assert.match(run.style.color, /--ansi-bg/);
});

test("256 colours and 24-bit colours resolve to rgb", () => {
  assert.equal(ansi256(196), "rgb(255,0,0)");
  assert.equal(ansi256(232), "rgb(8,8,8)");
  assert.equal(ansi256(255), "rgb(238,238,238)");
  const [run] = styled(parseAnsiRuns("\x1b[38;2;21;24;29mink\x1b[0m"));
  assert.equal(run.style.color, "rgb(21,24,29)");
});

test("the colon form of an extended colour reads the same way", () => {
  const [run] = styled(parseAnsiRuns("\x1b[38:2::21;24;29mink\x1b[0m"));
  assert.equal(run.style.color, "rgb(21,24,29)");
});

test("attributes are styles, and their off codes clear them", () => {
  const [bold] = styled(parseAnsiRuns("\x1b[1mbold\x1b[22m tail"));
  assert.equal(bold.style.bold, true);
  const [marks] = styled(parseAnsiRuns("\x1b[3;4;9mx\x1b[0m"));
  assert.deepEqual(marks.style, { italic: true, underline: true, strike: true });
  assert.deepEqual(styled(parseAnsiRuns("\x1b[23;24;29mx")), []);
});

test("an escape that moves the cursor or erases a line leaves no letters", () => {
  assert.equal(plain(parseAnsiRuns("\x1b[2Kok\r\x1b[1;1Hdone")), "ok\rdone");
  assert.equal(plain(parseAnsiRuns("\x1b[?25lhidden\x1b[?25h")), "hidden");
  assert.equal(plain(parseAnsiRuns("\x1b]0;window title\x07text")), "text");
});

test("a sequence the stream never finished shows nothing", () => {
  assert.equal(plain(parseAnsiRuns("done\x1b[38;5;")), "done");
  assert.equal(plain(parseAnsiRuns("done\x1b")), "done");
  assert.equal(plain(parseAnsiRuns("done\x1b]8;;https://example.com/")), "done");
});

test("an osc 8 link becomes an href, and a non-web target stays text", () => {
  const runs = parseAnsiRuns("see \x1b]8;;https://example.com/\x1b\\example\x1b]8;;\x1b\\ now");
  assert.equal(plain(runs), "see example now");
  assert.equal(runs.find((run) => run.href)?.href, "https://example.com/");
  assert.equal(plain(parseAnsiRuns("\x1b]8;;file:///etc/passwd\x07secret\x1b]8;;\x07")), "secret");
  assert.equal(parseAnsiRuns("\x1b]8;;file:///etc/passwd\x07secret").some((run) => run.href), false);
});

test("runs that end up styled alike are merged into one", () => {
  const runs = parseAnsiRuns("\x1b[31mred \x1b[31mstill red\x1b[0m");
  assert.deepEqual(styled(runs).map((run) => run.text), ["red still red"]);
});

test("a style never survives into the next call", () => {
  assert.deepEqual(styled(parseAnsiRuns("plain")), []);
});

test("hasAnsi answers for anything that could draw as anything else", () => {
  assert.equal(hasAnsi("two \x1b[2K lines"), true);
});
