import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  deliveredNotificationIds,
  formatPendingNotifications,
  formatPendingPointer,
  pendingNotificationsFor,
  pendingTitleFrom,
  PENDING_POINTER_CUSTOM_TYPE,
  PENDING_POINTER_PREFIX,
  PENDING_TOOL_NAME,
  recordPendingNotification,
  removePendingNotification,
} = await jiti.import("./pending-notifications.ts");
const { createPendingNotificationsExtension } = await jiti.import("./pending-notifications-extension.ts");

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

let sequence = 0;
function entry(overrides = {}) {
  sequence += 1;
  return {
    kind: "bash",
    id: `task-${sequence}`,
    title: "bun test",
    outcome: "completed",
    finishedAtMs: NOW - 60_000,
    parentSessionId: "parent",
    customType: "pi-web:bg-task-notification",
    messageId: `m${sequence}`,
    fetchHint: "read(\"/tmp/pi-bgtask/task.log\")",
    ...overrides,
  };
}

/**
 * The transcript entry a batch message leaves behind, as pi writes it.
 *
 * `appendCustomMessageEntry()` (`core/session-manager.js`) appends
 * `{ type: "custom_message", customType, content, display, details, … }` — `details` at the entry's
 * top level, not under a `message`. The suite used to hand `deliveredNotificationIds()` a
 * `{ type: "message", message: { role: "custom", details } }` entry, a shape pi never writes: the
 * tests stayed green while a delivered batch went on being listed as pending.
 */
function deliveredEntry(messageId) {
  return {
    type: "custom_message",
    customType: "pi-web:settled-reports",
    content: [{ type: "text", text: "Background bash task completed in 12s." }],
    display: true,
    details: { kind: "pi-web-settled-reports", notificationId: messageId },
  };
}

test("delivery is recognized off the entry pi actually writes", async () => {
  // Copied verbatim out of a real session file, so the shape this reads is the shape production
  // holds: if pi renames the entry type or moves `details`, this fails instead of the index
  // silently going back to listing reports the parent already has.
  const entry = JSON.parse(await readFile(new URL("./__fixtures__/settled-report-custom-message.json", import.meta.url), "utf8"));
  assert.equal(entry.type, "custom_message");
  assert.equal(entry.display, true);

  const delivered = deliveredNotificationIds([
    { type: "message", message: { role: "user", content: "prompt" } },
    { type: "message", message: { role: "assistant", content: [] } },
    entry,
  ]);
  assert.deepEqual([...delivered], [entry.details.notificationId]);
});

async function loadExtension() {
  const tools = new Map();
  const hooks = new Map();
  const sent = [];
  await createPendingNotificationsExtension().factory({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event); },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  return { tool: tools.get(PENDING_TOOL_NAME), hooks, sent };
}

/** Fire the turn-boundary hook the way pi does, against one session's transcript. */
function turnEnd(hooks, sent, { sessionId, entries = [] }) {
  hooks.get("turn_end")?.({}, {
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
  });
  return sent;
}

test("a settled report stays listed until it reaches the session, then it is gone", () => {
  recordPendingNotification(entry({ parentSessionId: "fresh-parent" }));
  const recorded = pendingNotificationsFor("fresh-parent", []);
  assert.equal(recorded.length, 1);

  // The report arriving is the only thing that clears it: the index reads delivery off the
  // parent's own transcript rather than guessing when pi appended the message.
  assert.equal(pendingNotificationsFor("fresh-parent", []).length, 1, "must not forget it while undelivered");
  assert.deepEqual(pendingNotificationsFor("fresh-parent", [deliveredEntry(recorded[0].messageId)]), []);
});

test("one parent never sees another parent's results", () => {
  recordPendingNotification(entry({ parentSessionId: "left-parent" }));
  recordPendingNotification(entry({ parentSessionId: "right-parent" }));
  assert.equal(pendingNotificationsFor("left-parent", []).length, 1);
  assert.equal(pendingNotificationsFor("right-parent", []).length, 1);
});

test("a resumed run takes the place of its own earlier entry", () => {
  const first = entry({ parentSessionId: "resume-parent", id: "child-session", messageId: "old-message" });
  recordPendingNotification(first);
  recordPendingNotification({ ...first, messageId: "new-message", finishedAtMs: NOW - 1000 });

  const pending = pendingNotificationsFor("resume-parent", []);
  assert.deepEqual(pending.map((item) => item.messageId), ["new-message"]);
});

test("a collected result leaves the index before its batch reaches the session", () => {
  const collected = entry({ parentSessionId: "collected-parent", kind: "subagent", id: "child-session" });
  const waiting = entry({ parentSessionId: "collected-parent" });
  recordPendingNotification(collected);
  recordPendingNotification(waiting);

  removePendingNotification("collected-parent", "subagent", "child-session");

  const pending = pendingNotificationsFor("collected-parent", []);
  assert.deepEqual(pending.map((item) => [item.kind, item.id]), [["bash", waiting.id]], "only the collected report is gone");
  removePendingNotification("collected-parent", "bash", waiting.id);
  assert.deepEqual(pendingNotificationsFor("collected-parent", []), []);
});

test("the index keeps its newest entries and drops the oldest", () => {
  for (let i = 0; i < 15; i += 1) {
    recordPendingNotification(entry({
      parentSessionId: "flood-parent", id: `task-${i}`, messageId: `flood-${i}`, finishedAtMs: NOW + i * 1000,
    }));
  }
  const pending = pendingNotificationsFor("flood-parent", []);
  assert.equal(pending.length, 12);
  assert.equal(pending[0].messageId, "flood-14", "newest first");
});

test("the counts stay exact while only the lines are capped", () => {
  const pending = Array.from({ length: 5 }, (_, index) => entry({
    kind: index < 2 ? "subagent" : "bash",
    finishedAtMs: NOW - (index + 1) * 60_000,
  }));
  const text = formatPendingNotifications(pending, NOW);

  assert.match(text, /^Pending background results: 5 \(3 commands, 2 subagents\)\./);
  assert.equal(text.split("\n").filter((line) => line.startsWith("  [")).length, 3);
  assert.match(text, /\+2 more/);
});

test("an empty index answers in words instead of returning nothing", () => {
  assert.match(formatPendingNotifications([], NOW), /^No pending background results\. Do not call this again until a reminder/);
});

test("a title is one line and short enough to scan", () => {
  assert.equal(pendingTitleFrom("bun test --filter subagent\nRan 12 tests"), "bun test --filter subagent");
  assert.equal(pendingTitleFrom("").length, 0);
  assert.equal(pendingTitleFrom("x".repeat(400)).length, 120);
  assert.ok(pendingTitleFrom("x".repeat(400)).endsWith("…"));
});

test("age is told in the coarsest unit that still distinguishes it", () => {
  const line = (secondsAgo) => formatPendingNotifications([entry({ finishedAtMs: NOW - secondsAgo * 1000 })], NOW);
  assert.match(line(5), /just now/);
  assert.match(line(90), /1m ago/);
  assert.match(line(7200), /2h ago/);
});

test("the tool lists what the calling session has not seen yet", async () => {
  const { tool } = await loadExtension();
  assert.equal(tool.exposure, "model-only", "a codemode script must not decide when the parent learns");
  // The schema already shows it takes no arguments; the description never says so.
  assert.doesNotMatch(tool.description, /Takes no arguments/);
  assert.match(tool.description, /Returns the count and one line per result/);
  // Over-eager calls were the problem: the reminder is the only trigger, not "check the index".
  assert.match(tool.description, /Read background results a reminder has just announced/);
  assert.match(tool.description, /never call this to poll a run — stop, and its report arrives/);

  // The tool formats against the real clock, so these are anchored to it rather than to NOW.
  const mine = entry({ parentSessionId: "tool-parent", messageId: "seen", finishedAtMs: Date.now() - 30_000 });
  const unseen = entry({
    parentSessionId: "tool-parent", kind: "subagent", id: "sub-child", title: "Inspect parser",
    fetchHint: 'get_subagent_result("sub-child")', finishedAtMs: Date.now() - 90_000,
  });
  recordPendingNotification(mine);
  recordPendingNotification(unseen);

  const result = await tool.execute("call-1", {}, undefined, undefined, {
    sessionManager: {
      getSessionId: () => "tool-parent",
      getEntries: () => [deliveredEntry("seen")],
    },
  });
  const text = result.content[0].text;

  assert.match(text, /^Pending background results: 1 \(1 subagent\)\./);
  assert.match(text, /\[subagent\] Inspect parser · completed · 1m ago → get_subagent_result\("sub-child"\)/);
  assert.equal(result.details.count, 1);
});

test("the tool answers without a session instead of throwing", async () => {
  const { tool } = await loadExtension();
  const result = await tool.execute("call-1", {}, undefined, undefined, { sessionManager: {} });
  assert.match(result.content[0].text, /No session/);
});

test("the reminder names the count, the split and the tool", () => {
  const pending = [
    entry({ kind: "bash", id: "t1" }),
    entry({ kind: "bash", id: "t2" }),
    entry({ kind: "subagent", id: "s1" }),
  ];
  const text = formatPendingPointer(pending);
  assert.match(text, /您有 3 条未处理的后台通知（2 个 bash 命令、1 个子代理）/);
  assert.match(text, /现在可以调用 pending_notifications 查看；没有这条提醒时不要调用/);
  // pi replays a custom message as a user turn, so the reminder carries the same guard the
  // reports do: it is not a message from the user and it sets no task.
  assert.ok(text.startsWith(PENDING_POINTER_PREFIX));
  assert.match(text, /not a message from the user/);
  assert.equal(formatPendingPointer([]), "");
});

test("a turn boundary with results waiting steers one reminder", async () => {
  const { hooks, sent } = await loadExtension();
  recordPendingNotification(entry({ parentSessionId: "pointer-parent", kind: "bash", messageId: "pm1" }));
  recordPendingNotification(entry({ parentSessionId: "pointer-parent", kind: "subagent", messageId: "pm2" }));

  turnEnd(hooks, sent, { sessionId: "pointer-parent" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, PENDING_POINTER_CUSTOM_TYPE);
  // Model-only: pi replays a custom message whatever `display` says, and the chat skips this one,
  // so the model always reads it and no card appears.
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { deliverAs: "steer" });
  assert.match(sent[0].message.content, /您有 2 条未处理的后台通知/);
  assert.deepEqual(sent[0].message.details.messageIds, ["pm1", "pm2"]);
  // A reminder is not a report: it must never carry the marker that clears the index.
  assert.equal(sent[0].message.details.notificationId, undefined);
});

test("the same waiting results are reminded about once, not at every turn", async () => {
  const { hooks, sent } = await loadExtension();
  recordPendingNotification(entry({ parentSessionId: "once-parent", messageId: "om1" }));

  turnEnd(hooks, sent, { sessionId: "once-parent" });
  turnEnd(hooks, sent, { sessionId: "once-parent" });
  turnEnd(hooks, sent, { sessionId: "once-parent" });

  assert.equal(sent.length, 1, "one reminder per batch, however long the run goes on");
});

test("a later batch is reminded about again", async () => {
  const { hooks, sent } = await loadExtension();
  recordPendingNotification(entry({ parentSessionId: "later-parent", messageId: "lm1" }));
  turnEnd(hooks, sent, { sessionId: "later-parent" });
  recordPendingNotification(entry({ parentSessionId: "later-parent", messageId: "lm2" }));
  turnEnd(hooks, sent, { sessionId: "later-parent" });

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].message.details.messageIds, ["lm2"]);
});

test("nothing waiting, nothing steered", async () => {
  const { hooks, sent } = await loadExtension();
  turnEnd(hooks, sent, { sessionId: "quiet-parent" });
  turnEnd(hooks, sent, { sessionId: "quiet-parent" });
  assert.equal(sent.length, 0);
});

test("a delivered batch is not reminded about", async () => {
  const { hooks, sent } = await loadExtension();
  recordPendingNotification(entry({ parentSessionId: "delivered-parent", messageId: "dm1" }));
  turnEnd(hooks, sent, { sessionId: "delivered-parent", entries: [deliveredEntry("dm1")] });
  assert.equal(sent.length, 0, "the report already reached the conversation");
});
