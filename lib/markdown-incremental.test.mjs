import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { normalizeDisplayMath, normalizeDisplayMathIncremental } = await jiti.import("./markdown.ts");
const { splitMarkdownBlocks, splitMarkdownBlocksIncremental } = await jiti.import("./markdown-blocks.ts");

const CORPUS = [
  [
    "## 渲染性能",
    "",
    "浏览器每帧大约有 16ms，`requestAnimationFrame` 里只做读取。",
    "",
    "1. 第一步",
    "",
    "2. 第二步，松散列表",
    "   继续这一项",
    "",
    "- tight",
    "- list",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "| 指标 | 值 |",
    "| --- | --- |",
    "| FPS | 60 |",
    "",
    "$$",
    "a + b",
    "$$",
    "",
    "> quote",
    "",
    "Text with `$$` in code and a trailing paragraph.",
    "",
    "Final paragraph **bold**.",
  ].join("\n"),
  [
    "Intro paragraph with $x + y$ inline math and a price of $20/mo.",
    "",
    "$$a + b$$",
    "",
    "$$",
    "\\frac{a}{b} = c",
    "",
    "d",
    "$$",
    "",
    " glued opener",
    "",
    "- item:",
    "  $$a + b$$",
    "- next",
    "",
    "\\[P(\\lambda)=o_b+\\lambda r_b\\]",
    "",
    String.raw`before`,
    String.raw`\[`,
    String.raw`x + y`,
    String.raw`\]`,
    "",
    String.raw`射线为 \(r_c = K^{-1}p\)。`,
    "",
    "run `AudioManager\\`1.cs` now",
  ].join("\n"),
  [
    "---",
    "title: front matter",
    "",
    "other: y",
    "---",
    "",
    "# Heading",
    "",
    "~~~",
    "tilde fence",
    "",
    "```",
    "~~~",
    "",
    "    indented code",
    "",
    "    more indented code",
    "",
    "<details>",
    "<summary>more</summary>",
    "",
    "hidden",
    "",
    "</details>",
    "",
    "<code>\\(inline\\)</code>",
    "",
    "[ref]: https://example.com/docs",
    "",
    "Use a <textarea> here",
    "and a button",
    "please",
    "",
    "5~7U 保证金 × 100~200倍杠杆",
    "",
    "见 https://example.com/docs。",
  ].join("\n"),
  [
    "1. 看门狗的原理是（ ）",
    "A. 监控温度",
    "B. 计数器",
    "2. 下一题",
    "",
    "- outer",
    "  more",
    "  - inner",
    "- next",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "$$",
    "x = 1",
    "",
    "y = 2",
    "$$",
    "",
    "    $20 + $6",
    "",
    "echo $HOME and $PATH in the shell",
  ].join("\n"),
  "",
  "one",
  "a\n\nb\n",
  "$$\n",
  "```\nunclosed fence\n",
  "text\n\n$$\nunclosed math\n\nmore\n",
  "## CRLF\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n\r\n$$x = 1$$\r\n\r\ndone",
];

/** Deterministic lines over an alphabet that stresses every block-level branch. */
function* randomDocuments(alphabet, count, seed) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
  for (let document = 0; document < count; document++) {
    const lines = [];
    const lineCount = 1 + Math.floor(next() * 8);
    for (let line = 0; line < lineCount; line++) {
      let text = "";
      const length = Math.floor(next() * 18);
      for (let index = 0; index < length; index++) text += alphabet[Math.floor(next() * alphabet.length)];
      lines.push(text);
    }
    yield lines.join("\n");
  }
}

function chunksOf(markdown, sizes) {
  const chunks = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(markdown.slice(offset, offset + size));
    offset += size;
  }
  if (offset < markdown.length) chunks.push(markdown.slice(offset));
  return chunks.filter((chunk) => chunk !== "");
}

function randomChunks(markdown, seed) {
  let state = seed;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const sizes = [];
  while (sizes.reduce((sum, size) => sum + size, 0) < markdown.length) {
    sizes.push(1 + Math.floor(next() * 7));
  }
  return chunksOf(markdown, sizes);
}

/** MarkdownBody's own sequence: normalize the growing text, then split it. */
function stream(markdown, chunks) {
  let normalizeCheckpoint = null;
  let splitCheckpoint = null;
  const steps = [];
  const feed = chunks.length > 0 ? chunks : [markdown];
  for (const chunk of feed) {
    const text = (steps.at(-1)?.text ?? "") + chunk;
    const normalized = normalizeDisplayMathIncremental(text, normalizeCheckpoint);
    normalizeCheckpoint = normalized.checkpoint;
    const split = splitMarkdownBlocksIncremental(normalized.text, splitCheckpoint);
    splitCheckpoint = split.checkpoint;
    steps.push({ text, normalized: normalized.text, blocks: split.blocks, normalizeCheckpoint, splitCheckpoint });
  }
  return steps;
}

function assertStreamMatchesWhole(markdown, chunks, label) {
  const steps = stream(markdown, chunks);
  assert.equal(steps.at(-1).text, markdown, `${label}: the chunks reassemble the text`);
  for (const step of steps) {
    assert.equal(step.normalized, normalizeDisplayMath(step.text), `${label}: normalization of\n${step.text}`);
    assert.deepEqual(step.blocks, splitMarkdownBlocks(step.normalized), `${label}: blocks of\n${step.text}`);
  }
  return steps;
}

test("a character at a time gives the whole text's normalization and blocks", () => {
  for (const [index, markdown] of CORPUS.entries()) {
    assertStreamMatchesWhole(markdown, [...markdown], `corpus ${index}`);
  }
});

test("random chunks give the whole text's normalization and blocks", () => {
  for (const [index, markdown] of CORPUS.entries()) {
    for (let seed = 1; seed <= 4; seed++) {
      assertStreamMatchesWhole(markdown, randomChunks(markdown, seed * 977 + index), `corpus ${index} seed ${seed}`);
    }
  }
  const alphabets = [
    ["a", " ", "`", "\\", "$", "[", "]", "(", ")", "#", "-", ">", "~", "\n", "中"],
    ["$$", "\\[", "\\]", "\\(", "\\)", "```", "~~~", "\n", "x", " ", "<code>", "</code>", "中", "---"],
    ["<", ">", "/", "b", " ", "\n", "`", "a", "!", "code", "pre"],
    [" ", "\t", "\n", "a", "$", "`", "\\", "中", "-", ">", "#", "~"],
  ];
  for (const [alphabet, markdown] of alphabets.flatMap((alphabet, alphabetIndex) =>
    [...randomDocuments(alphabet, 30, 31 + alphabetIndex, 10, 24)].map((markdown, index) => [alphabetIndex * 100 + index, markdown]),
  )) {
    assertStreamMatchesWhole(markdown, randomChunks(markdown, 31 + alphabet), `fuzz ${alphabet}`);
  }
});

test("a character at a time gives the whole text's result on fuzzed documents", () => {
  for (const [index, markdown] of [...randomDocuments(["a", "`", "\\", "$", "[", "]", "(", ")", " ", "\n", "中"], 40, 753)]) {
    assertStreamMatchesWhole(markdown, [...markdown], `fuzz ${index}`);
  }
});

test("a chunk that does not extend the text is recomputed whole", () => {
  const markdown = CORPUS[0];
  const steps = stream(markdown, [markdown]);
  const checkpoint = steps[0].normalizeCheckpoint;

  // An authoritative replacement: shorter, and not an extension of what came before.
  const replaced = "## A shorter answer\n\n$$x$$";
  const normalized = normalizeDisplayMathIncremental(replaced, checkpoint);
  assert.equal(normalized.text, normalizeDisplayMath(replaced));
  assert.equal(normalized.checkpoint.source, replaced);
  const split = splitMarkdownBlocksIncremental(normalized.text, steps[0].splitCheckpoint);
  assert.deepEqual(split.blocks, splitMarkdownBlocks(normalized.text));

  // Text that shrinks and then grows again.
  const shrunk = "## 渲染性能\n\n浏览器";
  const back = normalizeDisplayMathIncremental(shrunk, normalized.checkpoint);
  assert.equal(back.text, normalizeDisplayMath(shrunk));
  const backSplit = splitMarkdownBlocksIncremental(back.text, split.checkpoint);
  assert.deepEqual(backSplit.blocks, splitMarkdownBlocks(back.text));
});

test("a change of line ending recomputes whole", () => {
  const steps = stream("a\n", ["a\n"]);
  const mixed = "a\nb\r\nc";
  const normalized = normalizeDisplayMathIncremental(mixed, steps[0].normalizeCheckpoint);
  assert.equal(normalized.text, normalizeDisplayMath(mixed));
  const split = splitMarkdownBlocksIncremental(normalized.text, steps[0].splitCheckpoint);
  assert.deepEqual(split.blocks, splitMarkdownBlocks(normalized.text));
});

test("the committed prefix covers every line but the last", () => {
  const clean = CORPUS[0];
  const last = stream(clean, randomChunks(clean, 5)).at(-1);
  assert.equal(last.normalizeCheckpoint.lineCount, clean.split(/\r?\n/).length - 1);
  assert.equal(last.normalizeCheckpoint.lines.length, last.normalized.split(last.normalizeCheckpoint.lineBreak).length - 1);
  assert.equal(last.splitCheckpoint.lineCount, last.normalized.split("\n").length - 1);
  assert.equal(
    [...last.splitCheckpoint.blocks, last.splitCheckpoint.current.join("\n")].join(""),
    last.normalized.split("\n").slice(0, last.splitCheckpoint.lineCount).join("\n"),
  );

  // A document ending inside an unclosed `$$` or fence commits less: its last
  // block is still growing, so the cut before it is the safe one.
  for (const [index, markdown] of CORPUS.entries()) {
    if (!markdown.includes("\n")) continue;
    const step = stream(markdown, randomChunks(markdown, 5 + index)).at(-1);
    const lineBreak = step.normalizeCheckpoint.lineBreak;
    const sourceLines = markdown.split(/\r?\n/);
    const { lineCount, lines: committedLines } = step.normalizeCheckpoint;
    assert.ok(lineCount <= sourceLines.length - 1, `corpus ${index}`);
    // The committed output is what normalizing those lines on their own gives.
    assert.equal(
      normalizeDisplayMath(sourceLines.slice(0, lineCount).join(lineBreak)),
      committedLines.join(lineBreak),
      `corpus ${index}`,
    );
    assert.ok(committedLines.length <= step.normalized.split(lineBreak).length - 1, `corpus ${index}`);

    const splitLines = step.normalized.split("\n");
    assert.ok(step.splitCheckpoint.lineCount < splitLines.length, `corpus ${index}`);
    const committedText = splitLines.slice(0, step.splitCheckpoint.lineCount).join("\n");
    assert.equal(
      [...step.splitCheckpoint.blocks, step.splitCheckpoint.current.join("\n")].join(""),
      committedText,
      `corpus ${index}`,
    );
    assert.deepEqual(splitMarkdownBlocks(committedText), [...step.splitCheckpoint.blocks, step.splitCheckpoint.current.join("\n")], `corpus ${index}`);
  }
});

test("a growing text renormalizes only its tail", () => {
  // The checkpoint's state is what makes the tail enough: without it the resumed
  // run would start from a clean state and lose an open fence, an inline code
  // span or a raw HTML code tag. The last line is never committed, so each text
  // below ends on a line that leaves the state it is asserting.
  const inFence = "```ts\nconst a = 1;\n";
  let normalized = normalizeDisplayMathIncremental(inFence, null);
  assert.deepEqual(normalized.checkpoint.state, { fence: { marker: "`", size: 3 }, inlineCodeMarkerSize: 0, rawCodeTag: null });

  const withSpan = "a `code\nmore` b\n\\(x\\)";
  normalized = normalizeDisplayMathIncremental(withSpan, normalized.checkpoint);
  assert.equal(normalized.text, normalizeDisplayMath(withSpan));
  assert.deepEqual(normalized.checkpoint.state, { fence: null, inlineCodeMarkerSize: 0, rawCodeTag: null });

  const withRawTag = "<code>\\(inline\\)\n</code>\n\n\\(x\\)";
  normalized = normalizeDisplayMathIncremental(withRawTag, normalized.checkpoint);
  assert.equal(normalized.text, normalizeDisplayMath(withRawTag));
  assert.deepEqual(normalized.checkpoint.state, { fence: null, inlineCodeMarkerSize: 0, rawCodeTag: null });

  const stillInFence = "~~~\ntilde\n```\nnot a close\n";
  normalized = normalizeDisplayMathIncremental(stillInFence, normalized.checkpoint);
  assert.equal(normalized.text, normalizeDisplayMath(stillInFence));
  assert.deepEqual(normalized.checkpoint.state, { fence: { marker: "~", size: 3 }, inlineCodeMarkerSize: 0, rawCodeTag: null });
});

test("a first line that starts as front matter and keeps growing is not front matter", () => {
  // `---` alone opens front matter and stops the cutting for good; the same line
  // grown into `---#…` does not, so the flag must not be latched from it.
  const markdown = "---#))-#>[\\]\\ [$`a]\n\n`";
  const steps = stream(markdown, [...markdown]);
  assert.deepEqual(steps.at(-1).blocks, splitMarkdownBlocks(normalizeDisplayMath(markdown)));
  for (const step of steps) {
    assert.deepEqual(step.blocks, splitMarkdownBlocks(step.normalized), JSON.stringify(step.text));
  }
});

test("a carriage return arriving with its line feed recomputes whole", () => {
  const markdown = "a\r\nb\r\n\r\n$$x$$";
  const steps = stream(markdown, [...markdown]);
  assert.equal(steps.at(-1).normalized, normalizeDisplayMath(markdown));
  assert.deepEqual(steps.at(-1).blocks, splitMarkdownBlocks(normalizeDisplayMath(markdown)));
  for (const step of steps) {
    assert.equal(step.normalized, normalizeDisplayMath(step.text), JSON.stringify(step.text));
  }
});

test("a long reply commits its blocks and stops rescanning them", () => {
  const paragraphs = Array.from({ length: 200 }, (_, index) => `段落 ${index}：$x_${index}$ 与 \\(y\\) 的说明。`);
  const markdown = paragraphs.join("\n\n");
  const last = stream(markdown, randomChunks(markdown, 99)).at(-1);
  const whole = splitMarkdownBlocks(normalizeDisplayMath(markdown));
  // Every block but the one still growing is committed, so a chunk re-scans only
  // the tail rather than the whole reply.
  assert.ok(last.splitCheckpoint.blocks.length >= whole.length - 2, `${last.splitCheckpoint.blocks.length} of ${whole.length}`);
  assert.equal(last.normalizeCheckpoint.lineCount, markdown.split(/\r?\n/).length - 1);
  assert.deepEqual(last.blocks, whole);
});

test("the whole-text entry points keep their output", () => {
  for (const markdown of CORPUS) {
    assert.equal(normalizeDisplayMath(markdown), normalizeDisplayMathIncremental(markdown, null).text);
    assert.deepEqual(splitMarkdownBlocks(markdown), splitMarkdownBlocksIncremental(markdown, null).blocks);
  }
});
