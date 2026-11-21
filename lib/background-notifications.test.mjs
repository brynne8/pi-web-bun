import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  arrivingNotifications,
  mergeRailNotifications,
  railNotificationWindow,
  settledNotificationsFromMessages,
  RAIL_NOTIFICATION_LIMIT,
} = await createJiti(import.meta.url).import("./background-notifications.ts");
const { SETTLED_REPORTS_CUSTOM_TYPE, SETTLED_REPORTS_DETAILS_KIND } = await createJiti(import.meta.url).import("./settled-report.ts");

const report = (overrides = {}) => ({
  kind: "bash",
  id: "bash-3f2a9b1c",
  title: "bun test",
  outcome: "completed",
  finishedAtMs: 1_000,
  customType: "pi-web:bg-task-notification",
  fetchHint: 'get_result("bash-3f2a9b1c")',
  text: "…",
  ...overrides,
});

function batch(reports, { customType = SETTLED_REPORTS_CUSTOM_TYPE, kind = SETTLED_REPORTS_DETAILS_KIND } = {}) {
  return { role: "custom", customType, display: true, content: [], details: { kind, notificationId: "n1", reports } };
}

test("a batch's reports become rows, each carrying the entry that holds its card", () => {
  const messages = [
    { role: "user", content: "go" },
    batch([report(), report({ kind: "subagent", id: "child-session", title: "Inspect parser", outcome: "failed" })]),
  ];
  const rows = settledNotificationsFromMessages(messages, ["e1", "e2"]);
  assert.deepEqual(rows.map(({ kind, id, title, outcome, entryId }) => ({ kind, id, title, outcome, entryId })), [
    { kind: "bash", id: "bash-3f2a9b1c", title: "bun test", outcome: "completed", entryId: "e2" },
    { kind: "subagent", id: "child-session", title: "Inspect parser", outcome: "failed", entryId: "e2" },
  ]);
});

test("a message that is not a batch, or a batch of another kind, is not a row", () => {
  const messages = [
    { role: "custom", customType: "example:notice", details: { reports: [report()] } },
    batch([report()], { kind: "something-else" }),
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    batch([{ kind: "weather", id: "w1" }]),
  ];
  assert.deepEqual(settledNotificationsFromMessages(messages, ["e1", "e2", "e3", "e4"]), []);
});

test("a row without an entry id is still a row: the batch may predate the entry map", () => {
  const rows = settledNotificationsFromMessages([batch([report()])], [undefined]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryId, undefined);
});

test("arriving reports are rows too, and a delivered copy of the same result wins", () => {
  const delivered = [{ kind: "bash", id: "bash-3f2a9b1c", title: "bun test", outcome: "completed", finishedAtMs: 2_000, entryId: "e1" }];
  const arriving = [
    { kind: "bash", id: "bash-3f2a9b1c", title: "bun test", outcome: "completed", finishedAtMs: 2_000 },
    { kind: "subagent", id: "child", title: "later", outcome: "completed", finishedAtMs: 3_000 },
  ];
  const merged = mergeRailNotifications(delivered, arrivingNotifications(arriving));
  assert.deepEqual(merged.map((row) => `${row.kind}:${row.id}:${row.entryId ?? "arriving"}`), ["subagent:child:arriving", "bash:bash-3f2a9b1c:e1"]);
});

test("the window is the newest three, the rest counted", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ kind: "bash", id: `bash-${index}`, title: `t${index}`, outcome: "completed", finishedAtMs: 7 - index }));
  const { shown, hidden } = railNotificationWindow(rows);
  assert.equal(shown.length, RAIL_NOTIFICATION_LIMIT);
  assert.equal(shown[0].id, "bash-0");
  assert.equal(hidden, 4);
  assert.deepEqual(railNotificationWindow([]), { shown: [], hidden: 0 });
});
