import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { splitTurnSegments, turnHasAnswer } = await jiti.import("./turn-segments.ts");

const assistant = (content, extra = {}) => ({ role: "assistant", provider: "t", model: "m", content, ...extra });
const text = (value) => ({ type: "text", text: value });
const thinking = (value = "worked", extra = {}) => ({ type: "thinking", thinking: value, ...extra });
const toolCall = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: {} });
const image = () => ({ type: "image", source: { type: "url", url: "https://example.com/a.png" } });
const custom = (display = true) => ({ role: "custom", customType: "ext:note", content: "note", display });

const shape = (segments) => segments.map((segment) => [segment.kind, ...segment.parts.map((part) => `${part.index}:${part.start}-${part.end}`)]);

test("the words a turn wrote stay out of the fold, in the order they were written", () => {
  const messages = [assistant([
    thinking(),
    toolCall("call-1"),
    text("Inspected the parser."),
    thinking(),
    toolCall("call-2"),
    text("Fixed it."),
  ])];

  assert.deepEqual(shape(splitTurnSegments(messages, 0, 1)), [
    ["process", "0:0-2"],
    ["answer", "0:2-3"],
    ["process", "0:3-5"],
    ["answer", "0:5-6"],
  ]);
});

test("thinking and tool calls spanning stored entries make one group", () => {
  // pi-web's saved path stores each tool call as its own assistant entry.
  const messages = [
    assistant([thinking()]),
    assistant([toolCall("call-1")]),
    assistant([toolCall("call-2"), thinking("more")]),
    assistant([text("Done.")]),
  ];

  const segments = splitTurnSegments(messages, 0, 4);
  assert.equal(segments.length, 2);
  assert.deepEqual(shape(segments), [
    ["process", "0:0-1", "1:0-1", "2:0-2"],
    ["answer", "3:0-1"],
  ]);
  assert.equal(segments[0].messageCount, 3);
  assert.equal(segments[0].toolCallCount, 2);
});

test("text before a trailing tool call is shown, not filed away under it", () => {
  const messages = [assistant([text("I will call a tool."), toolCall("call-1")])];
  assert.deepEqual(shape(splitTurnSegments(messages, 0, 1)), [
    ["answer", "0:0-1"],
    ["process", "0:1-2"],
  ]);
});

test("an image is output: it stays on screen", () => {
  const messages = [assistant([toolCall("call-1"), image()])];
  assert.deepEqual(shape(splitTurnSegments(messages, 0, 1)), [
    ["process", "0:0-1"],
    ["answer", "0:1-2"],
  ]);
});

test("a range is in stored block indices, so a deferred thinking keeps its own", () => {
  // The empty block is dropped from the display but not from the indices: a part
  // reporting its own offsets would load the wrong stored thinking block.
  const messages = [assistant([thinking(""), text("Answer"), toolCall("call-1")])];
  const segments = splitTurnSegments(messages, 0, 1);
  assert.deepEqual(shape(segments), [
    ["answer", "0:1-2"],
    ["process", "0:2-3"],
  ]);
});

test("nothing to show opens nothing", () => {
  for (const content of [
    [],
    [thinking("")],
    [text("")],
    [text("   \n ")],
  ]) {
    const segments = splitTurnSegments([assistant(content)], 0, 1);
    assert.deepEqual(segments.map((segment) => segment.kind), [], JSON.stringify(content));
  }
});

test("a displayed custom message sits with the workings around it", () => {
  const messages = [
    assistant([text("First word.")]),
    custom(),
    assistant([toolCall("call-1")]),
    assistant([text("Last word.")]),
  ];

  assert.deepEqual(shape(splitTurnSegments(messages, 0, 4)), [
    ["answer", "0:0-1"],
    ["process", "1:-1--1", "2:0-1"],
    ["answer", "3:0-1"],
  ]);
});

test("a custom message kept for the model alone appears nowhere and counts nowhere (#1043)", () => {
  const messages = [assistant([toolCall("call-1")]), custom(false), assistant([text("Answer")])];
  const segments = splitTurnSegments(messages, 0, 3);
  assert.deepEqual(shape(segments), [
    ["process", "0:0-1"],
    ["answer", "2:0-1"],
  ]);
  assert.equal(segments[0].messageCount, 1);
});

test("only blocks inside the turn's range are read", () => {
  const messages = [
    { role: "user", content: "go" },
    assistant([text("Answer")]),
    { role: "user", content: "next" },
  ];
  assert.deepEqual(shape(splitTurnSegments(messages, 1, 2)), [["answer", "1:0-1"]]);
  assert.deepEqual(splitTurnSegments(messages, 0, 1), []);
});

test("a turn has an answer only when it wrote or returned something", () => {
  assert.equal(turnHasAnswer(splitTurnSegments([assistant([thinking(), toolCall("call-1")])], 0, 1)), false);
  assert.equal(turnHasAnswer(splitTurnSegments([assistant([thinking(), text("Done")])], 0, 1)), true);
  assert.equal(turnHasAnswer(splitTurnSegments([assistant([image()])], 0, 1)), true);
});

test("a deferred thinking stays in the group: the card loads it on demand", () => {
  const messages = [assistant([thinking("", { deferred: true }), text("Answer")])];
  assert.deepEqual(shape(splitTurnSegments(messages, 0, 1)), [
    ["process", "0:0-1"],
    ["answer", "0:1-2"],
  ]);
});

test("a turn with no words of its own has no answer, so its group stays open (#906)", () => {
  // The cases that used to keep Process details expanded because the turn's only
  // text was filed inside it: now the text is never inside, and what is left is
  // genuinely a turn with nothing to show.
  const unanswered = [
    assistant([thinking("long reasoning")], { stopReason: "length" }),
    assistant([], { stopReason: "error", errorMessage: "terminated" }),
    assistant([thinking(), toolCall("call-1"), text(" \n")]),
  ];
  for (const message of unanswered) {
    assert.equal(turnHasAnswer(splitTurnSegments([message], 0, 1)), false);
  }

  // Text that made it out before the error is an answer, wherever it sits.
  const answered = [
    assistant([text("Partial answer")], { stopReason: "error", errorMessage: "Connection closed" }),
    assistant([toolCall("call-1"), text("Final answer")]),
    assistant([text("Before the tool"), toolCall("call-1")]),
  ];
  for (const message of answered) {
    assert.equal(turnHasAnswer(splitTurnSegments([message], 0, 1)), true);
  }
});
