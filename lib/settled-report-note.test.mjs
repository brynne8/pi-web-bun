import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SETTLED_REPORTS_CUSTOM_TYPE,
  SETTLED_REPORTS_DETAILS_KIND,
  createSettledReportSink,
} = await jiti.import("./settled-report-note.ts");

function fakeParent({ running = false, alive = true } = {}) {
  const sent = [];
  const listeners = [];
  const parent = {
    sent,
    listeners,
    listenerCount: () => listeners.length,
    isAlive: () => alive,
    isRunning: () => running,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => { sent.push({ message, options }); },
      subscribe: (listener) => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
    },
  };
  return parent;
}

function deps(parent) {
  return {
    getSession: () => parent,
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
  };
}

const report = (id, overrides = {}) => ({
  kind: "bash",
  id,
  title: `bun test ${id}`,
  outcome: "completed",
  finishedAtMs: 1_700_000_000_000,
  customType: "pi-web:bg-task-notification",
  fetchHint: `read("/tmp/${id}.log")`,
  text: `Background bash task completed in 1s.\nCommand: bun test ${id}`,
  ...overrides,
});

const texts = (entry) => entry.message.content.map((block) => block.text);
const reports = (entry) => entry.message.details.reports;

test("the first report queues one message and later reports are appended to it", async () => {
  // The whole point: one queue element, however many reports land inside it. A message per
  // report would make pi deliver them one turn apart, which is what a burst of finished tasks
  // used to do.
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));

  await sink.deliver("parent", report("a"));
  await sink.deliver("parent", report("b"));
  await sink.deliver("parent", report("c"));

  assert.equal(parent.sent.length, 1, "one message per batch, not one per report");
  assert.deepEqual(texts(parent.sent[0]).map((text) => text.slice(-10)), [
    "bun test a", "bun test b", "bun test c",
  ]);
  assert.deepEqual(reports(parent.sent[0]).map((item) => item.id), ["a", "b", "c"]);
  assert.equal(parent.sent[0].message.customType, SETTLED_REPORTS_CUSTOM_TYPE);
  assert.equal(parent.sent[0].message.details.kind, SETTLED_REPORTS_DETAILS_KIND);
  assert.deepEqual(parent.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("the queued message holds the arrays by reference, so appends reach it", async () => {
  // pi stores the content array as given and reads it when the queue drains. If a later report
  // were appended to a copy, the batch would silently truncate at the first report.
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));
  await sink.deliver("parent", report("first"));
  const queued = parent.sent[0].message.content;

  await sink.deliver("parent", report("second"));

  assert.equal(queued.length, 2, "the queued array itself grew");
  assert.equal(queued[1].text, reports(parent.sent[0])[1].text);
});

test("a report that arrives after the message is consumed opens a new batch", async () => {
  // pi serializes the content into the session file when it appends the message, so appending
  // after that would leave the in-memory entry and the file holding different text.
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));
  await sink.deliver("parent", report("first"));

  const note = parent.sent[0].message.details;
  for (const listener of [...parent.listeners]) {
    listener({ type: "message_end", message: { customType: SETTLED_REPORTS_CUSTOM_TYPE, details: note } });
  }
  assert.equal(parent.listenerCount(), 0, "the consume listener must not linger");

  await sink.deliver("parent", report("second"));
  assert.equal(parent.sent.length, 2);
  assert.deepEqual(texts(parent.sent[1]).map((text) => text.slice(-14)), ["un test second"]);
});

test("a message_end for another message does not freeze the batch", async () => {
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));
  await sink.deliver("parent", report("first"));

  for (const listener of [...parent.listeners]) {
    listener({ type: "message_end", message: { customType: "pi-web:subagent-notification", details: {} } });
  }
  await sink.deliver("parent", report("second"));

  assert.equal(parent.sent.length, 1);
  assert.equal(parent.sent[0].message.content.length, 2);
});

test("a run that started under the send is retried as a queued follow-up", async () => {
  const parent = fakeParent({ running: false });
  let calls = 0;
  parent.inner.sendCustomMessage = async (message, options) => {
    calls += 1;
    if (calls === 1) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
    parent.sent.push({ message, options });
  };
  const sink = createSettledReportSink(deps(parent));

  await sink.deliver("parent", report("a"));

  assert.equal(calls, 2);
  assert.deepEqual(parent.sent[0].options, { deliverAs: "followUp", triggerTurn: false });
});

test("a parent that cannot be resolved drops the report instead of throwing", async () => {
  const sink = createSettledReportSink({
    getSession: () => undefined,
    reopenSession: async () => { throw new Error("must not reopen"); },
    resolveSessionPath: async () => null,
  });
  await sink.deliver("parent", report("a"));
});

test("a released parent is reopened so its batch still has somewhere to go", async () => {
  const live = fakeParent();
  const reopened = [];
  const sink = createSettledReportSink({
    getSession: () => undefined,
    reopenSession: async (sessionId, sessionFile) => { reopened.push([sessionId, sessionFile]); return live; },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
  });

  await sink.deliver("parent", report("a"));

  assert.deepEqual(reopened, [["parent", "/tmp/parent.jsonl"]]);
  assert.equal(live.sent.length, 1);
});

test("every report is indexed for pending_notifications while the batch is undelivered", async () => {
  // The registry is one per process, so this session id is this test's alone.
  const sessionId = "indexed-parent";
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));
  await sink.deliver(sessionId, report("a"));
  await sink.deliver(sessionId, report("b"));

  const { pendingNotificationsFor } = await jiti.import("./pending-notifications.ts");
  const note = parent.sent[0].message.details;
  const pending = pendingNotificationsFor(sessionId, []);
  assert.deepEqual(pending.map((entry) => entry.id), ["a", "b"]);
  // The index is keyed by the message, so one batch landing clears every report it carried.
  assert.deepEqual(pending.map((entry) => entry.messageId), [note.notificationId, note.notificationId]);
  assert.deepEqual(pendingNotificationsFor(sessionId, [
    { type: "message", message: { details: { notificationId: note.notificationId } } },
  ]), []);
});

test("pi holds a queued message's content by reference, so a batch grows in place", async () => {
  // The whole design rests on this: `sendCustomMessage` stores the array as given, `followUp()`
  // enqueues the same object, and the queue drains without copying. If pi ever snapshots the
  // content, a batch would silently truncate at whatever was queued first — so this pins the
  // property against the real SDK rather than against our own fakes.
  const agent = new Agent({ streamFn: async () => ({}) });
  const blocks = [{ type: "text", text: "Background bash task completed in 1s.\nCommand: bun test a" }];
  agent.followUp({
    role: "custom",
    customType: SETTLED_REPORTS_CUSTOM_TYPE,
    content: blocks,
    display: true,
    details: { notificationId: "n1" },
  });

  blocks.push({ type: "text", text: "Background bash task completed in 2s.\nCommand: bun test b" });

  const drained = agent.followUpQueue.drain();
  assert.equal(drained.length, 1, "one queue element");
  assert.equal(drained[0].content.length, 2, "the queued array itself grew");
  assert.equal(drained[0].content, blocks, "pi kept the reference, it did not copy");
});
