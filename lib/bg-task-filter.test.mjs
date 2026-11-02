import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { filterBgTasksBySession } = await createJiti(import.meta.url).import("./bg-task-filter.ts");

const task = (id, sessionId, overrides = {}) => ({
  id,
  sessionId,
  command: `echo ${id}`,
  logPath: `/tmp/${id}.log`,
  startedAtMs: 0,
  lastOutputAtMs: 0,
  finishedAtMs: null,
  exitCode: null,
  error: null,
  trigger: "background",
  killedByUser: false,
  ...overrides,
});

const tasks = [task("a", "s1"), task("b", "s2"), task("c", "s1", { finishedAtMs: 5, exitCode: 0 })];

test("only the current session's tasks are listed, finished ones included", () => {
  assert.deepEqual(filterBgTasksBySession(tasks, "s1").map((t) => t.id), ["a", "c"]);
});

test("another session's tasks never show", () => {
  assert.deepEqual(filterBgTasksBySession(tasks, "s2").map((t) => t.id), ["b"]);
  assert.deepEqual(filterBgTasksBySession(tasks, "s3"), []);
});

test("a page with no session selected lists no tasks", () => {
  assert.deepEqual(filterBgTasksBySession(tasks, null), []);
  assert.deepEqual(filterBgTasksBySession(tasks, undefined), []);
});
