import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  arrivingNotifications,
  consumedResults,
  fetchedNotifications,
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

function batch(reports, { customType = SETTLED_REPORTS_CUSTOM_TYPE, kind = SETTLED_REPORTS_DETAILS_KIND, timestamp = 2_000 } = {}) {
  return { role: "custom", customType, display: true, timestamp, content: [], details: { kind, notificationId: "n1", reports } };
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

/** An assistant turn that called `get_result` for one id, at one moment. */
const fetchCall = (id, timestamp) => ({
  role: "assistant",
  timestamp,
  content: [
    { type: "text", text: "fetching" },
    { type: "toolCall", id: "call-1", name: "get_result", arguments: { id } },
  ],
});

test("delivery is not consumption: only a fetch takes a result", () => {
  const delivered = [
    batch([report(), report({ kind: "subagent", id: "child-se9f2a1b", title: "Inspect parser", outcome: "failed" })], { timestamp: 2_000 }),
    { role: "user", content: "carry on" },
    fetchCall("bash-3f2a9b1c", 7_000),
  ];
  const [bash, subagent] = settledNotificationsFromMessages(delivered, ["e1", undefined, undefined]);
  assert.deepEqual({ consumed: bash.consumed, at: bash.consumedAtMs }, { consumed: true, at: 7_000 }, "the one it fetched");
  assert.deepEqual({ consumed: subagent.consumed, at: subagent.consumedAtMs }, { consumed: false, at: undefined }, "the one it only received");
  assert.equal(subagent.status.state, "failed");
  // A subagent answers to its 8-character prefix as well as its full session id.
  assert.equal(settledNotificationsFromMessages([...delivered, fetchCall("child-se", 8_000)], ["e1", undefined, undefined])[1].consumedAtMs, 8_000);
  assert.deepEqual([...consumedResults(delivered).keys()], ["bash-3f2a9b1c"], "another tool's id is not a read");
});

test("a result the model fetched instead of receiving is a row too, read at the moment it asked", () => {
  const messages = [
    fetchCall("bash-f01b9c70", 5_000),
    fetchCall("01a1fe28", 6_000),
  ];
  const rows = fetchedNotifications(messages);
  assert.deepEqual(rows.map((row) => [row.kind, row.id, row.consumed, row.consumedAtMs]), [
    ["bash", "bash-f01b9c70", true, 5_000],
    ["subagent", "01a1fe28", true, 6_000],
  ]);
});

test("a fetch that was refused is not a finished result, and one already delivered is not a second row", () => {
  const refused = {
    role: "assistant",
    timestamp: 5_000,
    content: [{ type: "toolCall", id: "call-refused", name: "get_result", arguments: { id: "bash-99999999" } }],
  };
  const answer = { role: "toolResult", toolCallId: "call-refused", isError: true, content: [{ type: "text", text: "still running" }] };
  assert.deepEqual(fetchedNotifications([refused, answer]), [], "a refused fetch is not a result");

  const delivered = settledNotificationsFromMessages([batch([report({ kind: "subagent", id: "01a1fe28f804" })])], ["e1"]);
  assert.deepEqual(fetchedNotifications([fetchCall("01a1fe28", 6_000)], delivered), [], "the batch already holds this result");
});

test("how a report ended is read back as the shape a row can say in any language", async () => {
  const { parseReportOutcome } = await createJiti(import.meta.url).import("./settled-report.ts");
  assert.deepEqual(parseReportOutcome("completed"), { state: "completed" });
  assert.deepEqual(parseReportOutcome("exited with code 1"), { state: "exit", code: 1 });
  assert.deepEqual(parseReportOutcome("terminated by a signal"), { state: "signal" });
  assert.deepEqual(parseReportOutcome("aborted"), { state: "stopped" });
  assert.deepEqual(parseReportOutcome("interrupted"), { state: "stopped" });
  assert.deepEqual(parseReportOutcome("failed (timed out after 30s)"), { state: "failed", detail: "timed out after 30s" });
  assert.deepEqual(parseReportOutcome("failed"), { state: "failed" });
  assert.deepEqual(parseReportOutcome("something new"), { state: "failed", detail: "something new" });
});
