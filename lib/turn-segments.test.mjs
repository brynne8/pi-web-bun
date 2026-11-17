import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { planTurnRender, splitTurnSegments, turnHasAnswer, unsegmentedTurnMessages } = await jiti.import("./turn-segments.ts");

const assistant = (content, extra = {}) => ({ role: "assistant", provider: "t", model: "m", content, ...extra });
const text = (value) => ({ type: "text", text: value });
const thinking = (value = "worked", extra = {}) => ({ type: "thinking", thinking: value, ...extra });
const toolCall = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: {} });
const image = () => ({ type: "image", source: { type: "url", url: "https://example.com/a.png" } });
const custom = (display = true) => ({ role: "custom", customType: "ext:note", content: "note", display });
const bash = (command) => ({ role: "bashExecution", command, output: "out", exitCode: 0 });
const user = (content) => ({ role: "user", content });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, content: [] });

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

test("every segment of a running message renders, even when several start on it", () => {
  // A response that thinks, writes and then calls a tool is three segments that
  // all start on the same stored message. A plan that walked message indices and
  // advanced one step per rendered thing dropped every segment after the first
  // one on that message, so a running turn's later steps vanished and the foot
  // was left waiting for a model with nothing above it.
  const messages = [
    { role: "user", content: "go" },
    assistant([thinking(), text("Step."), toolCall("call-1")]),
    { role: "toolResult", toolCallId: "call-1", content: [] },
    assistant([thinking(), text("Done."), toolCall("call-2")]),
  ];
  const segments = splitTurnSegments(messages, 1, messages.length);
  const plan = planTurnRender(segments, 0, messages.length);
  assert.deepEqual(
    plan.map((item) => (item.kind === "raw" ? `raw:${item.index}` : `${item.segment.kind}:${item.segmentIndex}`)),
    [
      "raw:0",
      "process:0",
      "answer:1",
      "process:2",
      "raw:2",
      "answer:3",
      "process:4",
    ],
  );
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

test("a ! command no segment covers renders in its own place in the turn", () => {
  // A session whose only entry is a shell command, and a turn whose reply never
  // came: the segment rewrite dropped upstream's fallback for a turn with no
  // reply, so the chat showed nothing at all once the session was read back.
  assert.deepEqual(unsegmentedTurnMessages([bash("git pull")], [], -1, 1), [0]);
  assert.deepEqual(unsegmentedTurnMessages([user("go"), bash("ls")], [], 0, 2), [1]);
});

test("a ! command run after the turn's last reply stays on screen", () => {
  const messages = [user("go"), assistant([text("Pulled.")], { stopReason: "stop" }), bash("ls")];
  const segments = splitTurnSegments(messages, 1, 3);
  assert.deepEqual(unsegmentedTurnMessages(messages, segments, 0, 3), [2]);

  // The same command after a later turn's reply, which is where a session that
  // talked first and then ran commands keeps them.
  const longer = [
    user("a"),
    assistant([text("one")], { stopReason: "stop" }),
    user("b"),
    assistant([text("two")], { stopReason: "stop" }),
    bash("ls"),
  ];
  assert.deepEqual(unsegmentedTurnMessages(longer, splitTurnSegments(longer, 3, 5), 2, 5), [4]);
});

test("a message before the turn's reply is the reply's own, and stays folded with it", () => {
  // Upstream skips it too: between a turn's anchor and its answer only replies
  // and custom messages render, so a command run before the reply belongs to the
  // turn's workings rather than beside them.
  const messages = [user("go"), bash("ls"), assistant([text("Listed.")], { stopReason: "stop" })];
  const segments = splitTurnSegments(messages, 1, 3);
  assert.deepEqual(unsegmentedTurnMessages(messages, segments, 0, 3), []);
});

test("a custom message after the last reply is a segment's, so it renders once", () => {
  const messages = [user("go"), assistant([text("Done.")], { stopReason: "stop" }), custom()];
  const segments = splitTurnSegments(messages, 1, 3);
  assert.deepEqual(unsegmentedTurnMessages(messages, segments, 0, 3), []);
});

test("a tool result past the last reply is listed, and renders inside its call's card", () => {
  // MessageView draws a tool result under its tool call and returns null for the
  // message on its own, so listing it costs nothing and matches upstream.
  const messages = [user("go"), assistant([toolCall("call-1")]), toolResult("call-1")];
  const segments = splitTurnSegments(messages, 1, 3);
  assert.deepEqual(unsegmentedTurnMessages(messages, segments, 0, 3), [2]);
});
