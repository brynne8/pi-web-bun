import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatBgRunList, subagentRunDescription, bgRunField, LIST_BG_RUNS_TOOL_NAME } = await jiti.import("./bg-runs.ts");

const NOW = Date.parse("2026-01-05T00:00:00.000Z");

function ago(ms) {
  return new Date(NOW - ms).toISOString();
}

function sub(overrides = {}) {
  return {
    kind: "subagent",
    id: "child-1",
    state: "running",
    lastActivityAt: ago(60_000),
    description: "explore: Find the parser",
    ...overrides,
  };
}

function bash(overrides = {}) {
  return {
    kind: "bash",
    id: "bash-3f2a9b1c",
    state: "running",
    lastActivityAt: ago(30_000),
    description: "npm run build",
    ...overrides,
  };
}

test("the tool's name says it lists, and covers every kind of background work", () => {
  assert.equal(LIST_BG_RUNS_TOOL_NAME, "list_bg_runs");
});

test("the default view is a process list, with live runs from either subsystem first", () => {
  const entries = [
    sub({ id: "done-new", state: "completed", lastActivityAt: ago(60_000) }),
    sub({ id: "run-1", state: "running", lastActivityAt: ago(4 * 60 * 60_000), description: "Running\twith\nnewline" }),
    bash({ id: "bash-live", state: "running", lastActivityAt: ago(3 * 60 * 60_000) }),
    sub({ id: "failed-old", state: "failed", lastActivityAt: ago(3 * 24 * 60 * 60_000) }),
    bash({ id: "bash-failed", state: "failed", lastActivityAt: ago(90_000) }),
    bash({ id: "bash-killed", state: "stopped", lastActivityAt: ago(40_000) }),
    bash({ id: "bash-done", state: "succeeded", lastActivityAt: ago(50_000) }),
  ];
  const lines = formatBgRunList(entries, { now: NOW }).split("\n");

  assert.equal(lines[0], "id\tkind\tstate\tlast_activity\tdescription");
  assert.match(lines[1], /^bash-live\tbash\trunning\t/);
  assert.match(lines[2], /^run-1\tsubagent\trunning\t/);
  assert.match(lines[2], /Running with newline$/);
  assert.match(lines[3], /^bash-killed\tbash\tstopped\t/);
  assert.match(lines[4], /^bash-failed\tbash\tfailed\t/);
  assert.equal(lines[5], "note: 1 older exit and 2 completed runs not shown; set status to \"all\" to include them.");
  assert.equal(lines.length, 6);
  assert.doesNotMatch(lines.join("\n"), /failed-old|done-new|bash-done/);
});

test("each subsystem's own state words decide a filter, read off its kind", () => {
  const entries = [
    sub({ id: "queued-1", state: "queued" }),
    bash({ id: "bash-stopping", state: "stopping" }),
    sub({ id: "sub-done", state: "completed" }),
    bash({ id: "bash-done", state: "succeeded" }),
    sub({ id: "sub-failed", state: "aborted", lastActivityAt: ago(3 * 24 * 60 * 60_000) }),
    bash({ id: "bash-signal", state: "signal", lastActivityAt: ago(3 * 24 * 60 * 60_000) }),
  ];

  const active = formatBgRunList(entries, { status: "active", now: NOW });
  assert.match(active, /^queued-1\tsubagent\tqueued/m);
  assert.match(active, /^bash-stopping\tbash\tstopping/m);
  assert.doesNotMatch(active, /done|failed|aborted|signal/);

  // "completed" is each subsystem's own word for a run that got its answer out.
  const completed = formatBgRunList(entries, { status: "completed", now: NOW });
  assert.match(completed, /sub-done\tsubagent\tcompleted/);
  assert.match(completed, /bash-done\tbash\tsucceeded/);

  // An exit that left work behind is unfinished whatever its age.
  const unfinished = formatBgRunList(entries, { status: "unfinished", now: NOW });
  assert.match(unfinished, /sub-failed/);
  assert.match(unfinished, /bash-signal/);
  assert.doesNotMatch(unfinished, /sub-done|bash-done/);

  const all = formatBgRunList(entries, { status: "all", now: NOW });
  assert.equal(all.split("\n").length, 7);
  assert.doesNotMatch(all, /note:/);
});

test("an unknown or missing status keeps the default view", () => {
  const entries = [sub({ id: "done-1", state: "completed" })];
  assert.equal(formatBgRunList(entries, { status: "everything", now: NOW }), formatBgRunList(entries, { now: NOW }));
  assert.match(formatBgRunList(entries, { status: "everything", now: NOW }), /note:/);
});

test("every filter answers in words instead of an empty table", () => {
  // Nothing to list is one answer whatever the filter asked for.
  for (const status of [undefined, "active", "completed", "all"]) {
    assert.equal(formatBgRunList([], { status, now: NOW }), "No background runs started by this session.");
  }
  // Runs exist, the filter hides them all: the answer says which, and how to ask for more.
  assert.equal(
    formatBgRunList([sub({ state: "completed" })], { status: "active", now: NOW }),
    "No background runs are running or queued.",
  );
  assert.equal(
    formatBgRunList([bash({ state: "running" })], { status: "completed", now: NOW }),
    "No completed background runs.",
  );
  assert.equal(
    formatBgRunList([bash({ state: "succeeded" })], { status: "unfinished", now: NOW }),
    "No active or unresolved background runs.",
  );
  assert.equal(
    formatBgRunList([bash({ state: "failed", lastActivityAt: ago(3 * 24 * 60 * 60_000) })], { now: NOW }),
    "No background runs are active or recently exited.\nnote: 1 older exit not shown; set status to \"unfinished\" or \"all\" to include them.",
  );
});

test("a run leaves every recent exit in, without a cap", () => {
  const entries = Array.from({ length: 30 }, (_, index) => bash({
    id: `bash-${index}`,
    state: "failed",
    lastActivityAt: new Date(NOW - index * 1000).toISOString(),
  }));
  const text = formatBgRunList(entries, { now: NOW });
  assert.equal(text.split("\n").length, 31);
  assert.match(text, /bash-0\tbash/);
  assert.match(text, /bash-29\tbash/);
});

test("a row's description is one line and short enough to scan", () => {
  const row = formatBgRunList([sub({ description: "explore:   find\nthe parser  " })], { now: NOW }).split("\n")[1];
  assert.ok(row.endsWith("explore: find the parser"), row);

  const long = bgRunField("x".repeat(200));
  assert.equal(long.length, 121);
  assert.ok(long.endsWith("…"));
});

test("a subagent's row names its profile in the description, where a command has no such thing", () => {
  assert.equal(subagentRunDescription("explore", "Find the parser"), "explore: Find the parser");
  assert.equal(subagentRunDescription("", "Find the parser"), "Find the parser");

  const row = formatBgRunList([sub({ description: subagentRunDescription("plan", "Map the branches") })], { now: NOW });
  assert.match(row, /^id\tkind\tstate\tlast_activity\tdescription\nchild-1\tsubagent\trunning\t.*\tplan: Map the branches$/);
});
