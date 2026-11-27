import assert from "node:assert/strict";
import test from "node:test";

import { groupAdjacentToolCalls, toolCallFamily } from "./tool-call-runs.ts";

/** A view stands for one stored response: the calls it asked for, or the words it wrote. */
function view(toolNames) {
  return toolNames === null ? { kind: "words" } : { kind: "calls", toolNames };
}

/**
 * A view stands for one stored response: the calls it asked for, or the words
 * it wrote. The membership mirrors what ChatWindow\x27s partToolFamily decides —
 * several calls in one response are only a run\x27s members when they are all of
 * one family — because the pure function itself cannot see inside a member.
 */
const membershipOf = (item) => {
  if (item.kind !== "calls") return { family: null, callCount: 0 };
  const families = new Set(item.toolNames.map(toolCallFamily));
  if (families.size !== 1) return { family: null, callCount: 0 };
  const family = [...families][0];
  return family === "other"
    ? { family: null, callCount: 0 }
    : { family, callCount: item.toolNames.length };
};

test("families cover the tools that actually run", () => {
  assert.equal(toolCallFamily("bash"), "execute");
  assert.equal(toolCallFamily("Bash"), "execute");
  assert.equal(toolCallFamily("powershell"), "execute");
  assert.equal(toolCallFamily("read"), "explore");
  assert.equal(toolCallFamily("grep"), "explore");
  assert.equal(toolCallFamily("glob"), "explore");
  assert.equal(toolCallFamily("ls"), "explore");
  assert.equal(toolCallFamily("edit"), "changes");
  assert.equal(toolCallFamily("write"), "changes");
  assert.equal(toolCallFamily("apply_patch"), "changes");
  assert.equal(toolCallFamily("codemode"), "codemode");
  assert.equal(toolCallFamily("Agent"), "subagent");
  assert.equal(toolCallFamily("get_subagent_result"), "subagent");
  assert.equal(toolCallFamily("await_notifications"), "notify");
  assert.equal(toolCallFamily("await_results"), "other");
  assert.equal(toolCallFamily("mcp__docs__search"), "other");
});

test("adjacent calls of one family merge, a singleton does not", () => {
  const groups = groupAdjacentToolCalls([view(["bash"]), view(["bash"]), view(["read"])], membershipOf);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "run");
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].callCount, 2);
  assert.equal(groups[0].family, "execute");
  assert.equal(groups[1].kind, "single");
  assert.equal(groups[1].family, "explore");
});

test("one response asking for several calls stands for all of them", () => {
  // A response that asks for parallel calls is one message holding several
  // toolCall blocks; the run's count has to say so.
  const groups = groupAdjacentToolCalls([view(["bash", "bash", "bash"])], membershipOf);
  assert.equal(groups[0].callCount, 3);
  assert.equal(groups[0].items.length, 1);
});

test("a run's count is its calls, not its members", () => {
  const groups = groupAdjacentToolCalls(
    [view(["bash", "bash"]), view(["bash"]), view(["bash", "bash", "bash"])],
    membershipOf,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "run");
  assert.equal(groups[0].callCount, 6);
  assert.equal(groups[0].items.length, 3);
});

test("the model's own words end a run", () => {
  const groups = groupAdjacentToolCalls([view(["bash"]), view(null), view(["bash"])], membershipOf);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.kind === "single"));
});

test("a change of family ends a run", () => {
  const groups = groupAdjacentToolCalls([view(["read"]), view(["bash"]), view(["read"])], membershipOf);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.kind === "single"));
});

test("a response mixing families stands alone", () => {
  const groups = groupAdjacentToolCalls([view(["bash", "read"])], membershipOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "single");
  assert.equal(groups[0].family, "other");
});
test("a family that reads differently every time is never merged", () => {
  const groups = groupAdjacentToolCalls([view(["mcp__docs__search"]), view(["mcp__docs__search"])], membershipOf);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.kind === "single"));
});

test("a run's identity is its first member, so a growing run keeps it", () => {
  const first = view(["bash"]);
  const groups = groupAdjacentToolCalls([first, view(["bash"])], membershipOf);
  assert.equal(groups[0].first, first);
});

test("the minimum run length counts calls, not members", () => {
  const items = [view(["bash"]), view(["bash"]), view(["bash"])];
  assert.equal(groupAdjacentToolCalls(items, membershipOf, { minRunLength: 3 })[0].kind, "run");
  assert.equal(groupAdjacentToolCalls(items, membershipOf, { minRunLength: 4 }).length, 3);
  // one response holding three calls is a run on its own
  assert.equal(groupAdjacentToolCalls([view(["bash", "bash", "bash"])], membershipOf, { minRunLength: 3 })[0].kind, "run");
});


test("a stretch of mixed families groups the way it reads", () => {
  const items = [view(["read"]), view(["read"]), view(["read"]), view(["bash"]), view(["read"])];
  const groups = groupAdjacentToolCalls(items, membershipOf);
  assert.deepEqual(groups.map((group) => [group.kind, group.items.length]), [
    ["run", 3],
    ["single", 1],
    ["single", 1],
  ]);
});

test("a long stretch of parallel calls collapses to one row", () => {
  // What a heavy turn looks like now: many responses, several calls each, one row.
  const items = Array.from({ length: 12 }, () => view(["bash", "bash"]));
  const groups = groupAdjacentToolCalls(items, membershipOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "run");
  assert.equal(groups[0].callCount, 24);
  assert.equal(groups[0].items.length, 12);
});

test("a stretch being written groups exactly as a finished one does", () => {
  // The group holds the whole stretch, written or not: a run being written shows
  // one row however long it gets, and what the current step is, is one click away.
  const growing = [view(["bash"]), view(["bash"]), view(["bash"])];
  const groups = groupAdjacentToolCalls(growing, membershipOf);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].callCount, 3);
});
