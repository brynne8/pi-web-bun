import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { answerTextEntryId, createSubagentCompactionGuardExtension, SUBAGENT_COMPACTION_GUARD_EXTENSION_NAME } =
  await jiti.import("./subagent-compaction-guard.ts");

let nextId = 0;
const id = (prefix) => `${prefix}-${nextId++}`;

/** One assistant message entry, with `content` as the blocks it ended with. */
function assistant(content, stopReason = "stop", entryId = id("a")) {
  return { type: "message", id: entryId, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content, stopReason, usage: {} } };
}
function user(text, entryId = id("u")) {
  return { type: "message", id: entryId, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text }] } };
}
function toolResult(entryId = id("r")) {
  return { type: "message", id: entryId, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } };
}
const text = (t) => ({ type: "text", text: t });
const thinking = (t) => ({ type: "thinking", thinking: t });
const toolCall = () => ({ type: "toolCall", id: "call-1", name: "read", arguments: {} });

/** The extension's one handler, as pi would call it. */
function guardHandler() {
  const handlers = {};
  const extension = createSubagentCompactionGuardExtension();
  extension.factory({ on: (event, handler) => { handlers[event] = handler; } });
  return (event) => handlers["session_before_compact"](event, {});
}

test("only a message ending in words is the answer just written", () => {
  const report = assistant([thinking("drafting"), text("Here is the report.")]);
  assert.equal(answerTextEntryId([user("do it"), report]), report.id);
  // Tool calls and thinking are unfinished work: the child has more to do.
  assert.equal(answerTextEntryId([assistant([text("let me look"), toolCall()])]), undefined);
  assert.equal(answerTextEntryId([assistant([toolCall()])]), undefined);
  assert.equal(answerTextEntryId([assistant([thinking("still reasoning")])]), undefined);
  assert.equal(answerTextEntryId([assistant([text("   ")])]), undefined);
  // A response that was cut short, stopped, or errored is not a finished report either.
  for (const stopReason of ["length", "aborted", "error"]) {
    assert.equal(answerTextEntryId([assistant([text("half a report")], stopReason)]), undefined);
  }
  // Something newer than the answer means the child is working again.
  const report2 = assistant([text("done.")]);
  assert.equal(answerTextEntryId([report2, toolResult()]), undefined);
  assert.equal(answerTextEntryId([report2, user("and now this")]), undefined);
  // Entries the model never reads do not hide the answer.
  const report3 = assistant([text("done.")]);
  assert.equal(answerTextEntryId([report3, { type: "custom", id: id("c"), parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "pi-web:subagent-result", data: {} }]), report3.id);
  // A message the model does read is new work, even when the file keeps it as its own entry kind.
  assert.equal(answerTextEntryId([report3, { type: "custom_message", id: id("m"), parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "pi-web:subagent-notification", content: [text("a report arrived")], display: true }]), undefined);
  assert.equal(answerTextEntryId([]), undefined);
});

test("a threshold compaction right after the answer is cancelled, once per answer", () => {
  const beforeCompact = guardHandler();
  const report = assistant([text("the report")]);
  const branch = [user("do it"), report];

  assert.deepEqual(beforeCompact({ reason: "threshold", branchEntries: branch }), { cancel: true });
  // The same answer again (the next prompt's check) is not held twice: the run that follows
  // must not carry a context already over the threshold.
  assert.equal(beforeCompact({ reason: "threshold", branchEntries: branch }), undefined);

  const next = assistant([text("second report")]);
  assert.deepEqual(beforeCompact({ reason: "threshold", branchEntries: [...branch, user("more"), next] }), { cancel: true });
});

test("the guard holds neither manual compaction nor overflow recovery", () => {
  const beforeCompact = guardHandler();
  const report = assistant([text("the report")]);
  const branch = [user("do it"), report];

  assert.equal(beforeCompact({ reason: "manual", branchEntries: branch }), undefined);
  assert.equal(beforeCompact({ reason: "overflow", branchEntries: branch }), undefined);

  // A child mid-work compacts as pi does, and a later answer is held on its own.
  const working = [user("do it"), assistant([toolCall()])];
  assert.equal(beforeCompact({ reason: "threshold", branchEntries: working }), undefined);
  const done = assistant([text("finished at last")]);
  assert.deepEqual(beforeCompact({ reason: "threshold", branchEntries: [...working, toolResult(), done] }), { cancel: true });
});

test("the guard registers no tools and hides itself from the panel", () => {
  const extension = createSubagentCompactionGuardExtension();
  assert.equal(extension.name, SUBAGENT_COMPACTION_GUARD_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
});
