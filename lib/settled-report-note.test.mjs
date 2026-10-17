import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";

/** The dead-letter box the sink writes to (`<tmpdir>/pi-web-dead-letters`), rebuilt here rather than exported. */
const DEAD_LETTER_DIR = join(tmpdir(), "pi-web-dead-letters");

const jiti = createJiti(import.meta.url);
const {
  SETTLED_REPORTS_CUSTOM_TYPE,
  SETTLED_REPORTS_DETAILS_KIND,
  createSettledReportSink,
} = await jiti.import("./settled-report-note.ts");
const { createBgTaskNotifier } = await jiti.import("./bash-bg-tasks.ts");

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

function deps(parent, overrides = {}) {
  return {
    getSession: () => parent,
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    ...overrides,
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
  const sink = createSettledReportSink(deps(parent, { sleep: async () => {} }));

  await sink.deliver("parent", report("a"));

  assert.equal(calls, 2);
  assert.deepEqual(parent.sent[0].options, { deliverAs: "followUp", triggerTurn: false });
});

test("a busy parent is retried on an exponential backoff, then queued", async () => {
  const parent = fakeParent({ running: true });
  const calls = [];
  parent.inner.sendCustomMessage = async (message, options) => {
    calls.push(options);
    // Busy twice, then the parent clears: the third attempt queues the report.
    if (calls.length < 3) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
    parent.sent.push({ message, options });
  };
  const sleeps = [];
  const sink = createSettledReportSink(deps(parent, { sleep: async (ms) => { sleeps.push(ms); } }));

  await sink.deliver("parent", report("a"));

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { deliverAs: "followUp", triggerTurn: true }, "the first attempt may start a turn");
  assert.deepEqual(calls[1], { deliverAs: "followUp", triggerTurn: false }, "a retry only queues");
  assert.deepEqual(calls[2], { deliverAs: "followUp", triggerTurn: false });
  // 500 ms then 1000 ms, each carrying up to 200 ms of jitter.
  assert.ok(sleeps[0] >= 500 && sleeps[0] < 700, `first delay ${sleeps[0]}`);
  assert.ok(sleeps[1] >= 1000 && sleeps[1] < 1200, `second delay ${sleeps[1]}`);
  assert.equal(parent.sent.length, 1);
});

test("a parent that never clears is dead-lettered after the retries are exhausted", async (t) => {
  const sessionId = "dead-letter-parent";
  const parent = fakeParent({ running: true });
  let calls = 0;
  let notificationId;
  parent.inner.sendCustomMessage = async (message) => {
    calls += 1;
    notificationId = message.details.notificationId;
    throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
  };
  const sleeps = [];
  const sink = createSettledReportSink(deps(parent, { sleep: async (ms) => { sleeps.push(ms); } }));

  await assert.rejects(sink.deliver(sessionId, report("a")), /already processing/);

  const file = join(DEAD_LETTER_DIR, `${notificationId}.json`);
  t.after(() => rmSync(file, { force: true }));
  assert.equal(calls, 8, "one initial attempt plus seven retries");
  assert.equal(sleeps.length, 7);
  assert.ok(sleeps.at(-1) >= 30_000 && sleeps.at(-1) < 30_200, `the last delay is capped at 30 s: ${sleeps.at(-1)}`);
  assert.ok(existsSync(file), "the record lands on disk");
  const record = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.notificationId, notificationId);
  assert.equal(record.attempts, 8);
  assert.match(record.error, /already processing/);
  assert.deepEqual(record.reports.map((item) => item.id), ["a"]);
  assert.equal(record.reports[0].text, report("a").text);
});

test("a send that fails for another reason is dead-lettered without retrying", async (t) => {
  const sessionId = "dead-letter-hard-failure";
  const parent = fakeParent();
  let calls = 0;
  let notificationId;
  parent.inner.sendCustomMessage = async (message) => {
    calls += 1;
    notificationId = message.details.notificationId;
    throw new Error("session is disposed");
  };
  const sleeps = [];
  const sink = createSettledReportSink(deps(parent, { sleep: async (ms) => { sleeps.push(ms); } }));

  await assert.rejects(sink.deliver(sessionId, report("a")), /session is disposed/);

  const file = join(DEAD_LETTER_DIR, `${notificationId}.json`);
  t.after(() => rmSync(file, { force: true }));
  assert.equal(calls, 1, "only a busy parent is worth retrying");
  assert.deepEqual(sleeps, []);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).attempts, 1);
});

test("a report after a dead-lettered batch opens a fresh note", async (t) => {
  const sessionId = "dead-letter-recover";
  const parent = fakeParent({ running: true });
  let calls = 0;
  let notificationId;
  parent.inner.sendCustomMessage = async (message, options) => {
    calls += 1;
    notificationId = message.details.notificationId;
    // The first batch exhausts its retries; the next report's send succeeds.
    if (calls <= 8) throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages.");
    parent.sent.push({ message, options });
  };
  const sink = createSettledReportSink(deps(parent, { sleep: async () => {} }));

  await assert.rejects(sink.deliver(sessionId, report("lost")));
  const file = join(DEAD_LETTER_DIR, `${notificationId}.json`);
  t.after(() => rmSync(file, { force: true }));

  await sink.deliver(sessionId, report("kept"));

  assert.equal(parent.sent.length, 1, "the later report must not append to the dead batch");
  assert.equal(parent.sent[0].message.content.length, 1);
  assert.equal(parent.sent[0].message.content[0].text, report("kept").text);
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
  // pi appends that message as a `custom_message` entry with `details` at its top level
  // (`appendCustomMessageEntry`), which is the shape the index reads delivery off.
  assert.deepEqual(pending.map((entry) => entry.messageId), [note.notificationId, note.notificationId]);
  assert.deepEqual(pendingNotificationsFor(sessionId, [
    { type: "custom_message", customType: "pi-web:settled-reports", content: [], display: true, details: note },
  ]), []);
});

test("a background command and a subagent that finish together share one batch", async () => {
  // The claim the design rests on, driven through the two real call sites rather than through
  // `sink.deliver()` twice: every other case here hands the sink reports it built itself, so a
  // sink that batched only same-kind reports would pass all of them. The bash side is the
  // notifier (`createBgTaskNotifier`), the subagent side is the shape `notifyParent` builds —
  // the one `lib/subagent-runtime.ts` hands over.
  const parent = fakeParent({ running: true });
  const sink = createSettledReportSink(deps(parent));
  const notifier = createBgTaskNotifier(deps(parent), sink);

  await notifier.notify("mixed-parent", "Background bash task completed in 5s.\nCommand: bun test", {
    command: "bun test",
    logPath: "/tmp/pi-web-bg-tasks/alpha.log",
    startedAtMs: 1_700_000_000_000,
    finishedAtMs: 1_700_000_005_000,
    exitCode: 0,
  });
  await sink.deliver("mixed-parent", {
    kind: "subagent",
    id: "child-session",
    title: "review the fork",
    outcome: "completed",
    finishedAtMs: 1_700_000_006_000,
    customType: "pi-web:subagent-notification",
    fetchHint: 'get_subagent_result("child-session")',
    text: "Subagent child-session completed.\n\nParser found",
  });

  assert.equal(parent.sent.length, 1, "one message for both, not one turn each");
  assert.equal(parent.sent[0].message.content.length, 2);
  assert.deepEqual(reports(parent.sent[0]).map((item) => [item.kind, item.customType]), [
    ["bash", "pi-web:bg-task-notification"],
    ["subagent", "pi-web:subagent-notification"],
  ], "each report keeps the custom type that picks its own card");
  assert.deepEqual(texts(parent.sent[0]).map((text) => text.split("\n")[0]), [
    "Background bash task completed in 5s.",
    "Subagent child-session completed.",
  ]);
  // The command's report is the notifier's own work: the log's id, the command as its title, and
  // a hint the model can copy straight out.
  const [bash] = reports(parent.sent[0]);
  assert.equal(bash.id, "alpha.log");
  assert.equal(bash.title, "bun test");
  assert.equal(bash.outcome, "completed");
  assert.equal(bash.fetchHint, 'read("/tmp/pi-web-bg-tasks/alpha.log")');

  // Both ride the one message, so the batch landing clears the pair at once. The registry is one
  // per process, so this session id is this test's alone.
  const { pendingNotificationsFor } = await jiti.import("./pending-notifications.ts");
  const note = parent.sent[0].message.details;
  const pending = pendingNotificationsFor("mixed-parent", []);
  assert.deepEqual(pending.map((item) => [item.kind, item.messageId]).sort(), [
    ["bash", note.notificationId],
    ["subagent", note.notificationId],
  ]);
  assert.deepEqual(pendingNotificationsFor("mixed-parent", [
    { type: "custom_message", customType: SETTLED_REPORTS_CUSTOM_TYPE, content: [], display: true, details: note },
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
