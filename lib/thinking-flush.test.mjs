import assert from "node:assert/strict";
import test from "node:test";

import { resolveThinkingVisibleText } from "./thinking-flush.ts";

/** Streams `full` in slices, as the agent events would, and collects what renders. */
function stream(full, slice) {
  const frames = [];
  let previous = null;
  for (let end = 0; end <= full.length; end += slice) {
    const raw = full.slice(0, Math.min(end, full.length));
    const result = resolveThinkingVisibleText(raw, true, previous);
    previous = result.checkpoint;
    frames.push(result.text);
  }
  return frames;
}

test("a finished block releases everything", () => {
  const raw = "first paragraph\n\nsecond half of a thought";
  const result = resolveThinkingVisibleText(raw, false, null);
  assert.equal(result.text, raw);
  assert.equal(result.checkpoint.released, raw.length);
});

test("nothing shows before the first paragraph is complete", () => {
  const result = resolveThinkingVisibleText("still typing the first line", true, null);
  assert.equal(result.text, "");
  assert.equal(result.checkpoint.released, 0);
});

test("a completed paragraph shows whole, the partial one waits", () => {
  const raw = "one\n\ntwo\n\nthree is still arriving";
  const result = resolveThinkingVisibleText(raw, true, null);
  assert.equal(result.text, "one\n\ntwo\n\n");
});

test("the released text only grows as paragraphs complete", () => {
  const frames = stream("a\n\nbb\n\nccc", 3);
  // one render per completed paragraph, and nothing before the first
  assert.deepEqual(frames.filter((text, i) => text !== frames[i - 1]), ["", "a\n\n", "a\n\nbb\n\n"]);
});

test("a chunk that adds no paragraph leaves the rendered text alone", () => {
  const first = resolveThinkingVisibleText("done\n\nnow typ", true, null);
  const second = resolveThinkingVisibleText("done\n\nnow typing more", true, first.checkpoint);
  assert.equal(second.text, first.text);
  assert.equal(second.checkpoint.released, first.checkpoint.released);
});

test("a blank line with trailing spaces still ends a paragraph", () => {
  const result = resolveThinkingVisibleText("one\n   \ntwo", true, null);
  assert.equal(result.text, "one\n   \n");
});

test("a carriage-return pair ends a paragraph", () => {
  const result = resolveThinkingVisibleText("one\r\n\r\ntwo", true, null);
  assert.equal(result.text, "one\r\n\r\n");
});

test("a single newline is not a paragraph break", () => {
  const result = resolveThinkingVisibleText("one\ntwo\nthree", true, null);
  assert.equal(result.text, "");
});

test("a replacement shorter than what was released starts over", () => {
  const first = resolveThinkingVisibleText("one\n\ntwo\n\nthree", true, null);
  assert.equal(first.checkpoint.released, 10);
  // an authoritative re-send of a shorter thought must not clamp to 8
  const second = resolveThinkingVisibleText("short", true, first.checkpoint);
  assert.equal(second.text, "");
  assert.equal(second.checkpoint.released, 0);
});

test("a replacement that is longer still releases its own paragraphs", () => {
  const first = resolveThinkingVisibleText("one\n\ntwo", true, null);
  const second = resolveThinkingVisibleText("one\n\ntwo\n\nthree", true, first.checkpoint);
  assert.equal(second.text, "one\n\ntwo\n\n");
});

test("streaming then finishing releases the whole thought", () => {
  const raw = "one\n\ntwo\n\nthree still going";
  let previous = null;
  let last = "";
  for (let end = 1; end <= raw.length; end++) {
    const result = resolveThinkingVisibleText(raw.slice(0, end), true, previous);
    previous = result.checkpoint;
    last = result.text;
  }
  assert.equal(last, "one\n\ntwo\n\n");
  const done = resolveThinkingVisibleText(raw, false, previous);
  assert.equal(done.text, raw);
});

test("a thought with no paragraph break at all shows nothing until it ends", () => {
  const raw = "a short thought with no blank line in it";
  const streaming = resolveThinkingVisibleText(raw, true, null);
  assert.equal(streaming.text, "");
  const done = resolveThinkingVisibleText(raw, false, streaming.checkpoint);
  assert.equal(done.text, raw);
});

test("every frame of a stream is a prefix of the raw text", () => {
  const raw = "p1\n\np2 has **bold\n\np3\n\np4 tail arriving";
  for (const text of stream(raw, 2)) {
    assert.ok(raw.startsWith(text), `${JSON.stringify(text)} is not a prefix`);
  }
});
