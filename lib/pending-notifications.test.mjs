import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  formatPendingNotifications,
  pendingNotificationDetails,
  pendingNotificationsFor,
  pendingTitleFrom,
  PENDING_TOOL_NAME,
  recordPendingNotification,
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
    markerId: `m${sequence}`,
    fetchHint: "read(\"/tmp/pi-bgtask/task.log\")",
    ...overrides,
  };
}

/** The transcript entry a delivered report leaves behind, as pi writes it. */
function deliveredEntry(markerId) {
  return { type: "message", message: { role: "custom", details: pendingNotificationDetails(markerId) } };
}

async function loadTool() {
  const tools = new Map();
  await createPendingNotificationsExtension().factory({
    registerTool(tool) { tools.set(tool.name, tool); },
  });
  return tools.get(PENDING_TOOL_NAME);
}

test("a settled report stays listed until it reaches the session, then it is gone", () => {
  recordPendingNotification(entry({ parentSessionId: "fresh-parent" }));
  const recorded = pendingNotificationsFor("fresh-parent", []);
  assert.equal(recorded.length, 1);

  // The report arriving is the only thing that clears it: the index reads delivery off the
  // parent's own transcript rather than guessing when pi appended the message.
  assert.equal(pendingNotificationsFor("fresh-parent", []).length, 1, "must not forget it while undelivered");
  assert.deepEqual(pendingNotificationsFor("fresh-parent", [deliveredEntry(recorded[0].markerId)]), []);
});

test("one parent never sees another parent's results", () => {
  recordPendingNotification(entry({ parentSessionId: "left-parent" }));
  recordPendingNotification(entry({ parentSessionId: "right-parent" }));
  assert.equal(pendingNotificationsFor("left-parent", []).length, 1);
  assert.equal(pendingNotificationsFor("right-parent", []).length, 1);
});

test("a resumed run takes the place of its own earlier entry", () => {
  const first = entry({ parentSessionId: "resume-parent", id: "child-session", markerId: "old-marker" });
  recordPendingNotification(first);
  recordPendingNotification({ ...first, markerId: "new-marker", finishedAtMs: NOW - 1000 });

  const pending = pendingNotificationsFor("resume-parent", []);
  assert.deepEqual(pending.map((item) => item.markerId), ["new-marker"]);
});

test("the index keeps its newest entries and drops the oldest", () => {
  for (let i = 0; i < 15; i += 1) {
    recordPendingNotification(entry({
      parentSessionId: "flood-parent", id: `task-${i}`, markerId: `flood-${i}`, finishedAtMs: NOW + i * 1000,
    }));
  }
  const pending = pendingNotificationsFor("flood-parent", []);
  assert.equal(pending.length, 12);
  assert.equal(pending[0].markerId, "flood-14", "newest first");
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
  assert.equal(formatPendingNotifications([], NOW), "No pending background results.");
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
  const tool = await loadTool();
  assert.equal(tool.exposure, "model-only", "a codemode script must not decide when the parent learns");

  // The tool formats against the real clock, so these are anchored to it rather than to NOW.
  const mine = entry({ parentSessionId: "tool-parent", markerId: "seen", finishedAtMs: Date.now() - 30_000 });
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
  const tool = await loadTool();
  const result = await tool.execute("call-1", {}, undefined, undefined, { sessionManager: {} });
  assert.match(result.content[0].text, /No session/);
});
