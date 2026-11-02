import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { bgTaskState } = await createJiti(import.meta.url).import("./bg-task-status.ts");

const task = (overrides = {}) => ({
  id: "t",
  sessionId: "s",
  command: "bun test",
  logPath: "/tmp/t.log",
  startedAtMs: 0,
  lastOutputAtMs: 0,
  finishedAtMs: null,
  exitCode: null,
  error: null,
  trigger: "background",
  killedByUser: false,
  ...overrides,
});

test("a running task is running, and a killed one is stopping until it settles", () => {
  assert.equal(bgTaskState(task()), "running");
  assert.equal(bgTaskState(task({ killedByUser: true })), "stopping");
});

test("a finished task says how it ended, not merely that it did", () => {
  assert.equal(bgTaskState(task({ finishedAtMs: 1, exitCode: 0 })), "succeeded");
  assert.equal(bgTaskState(task({ finishedAtMs: 1, exitCode: 2 })), "failed");
  assert.equal(bgTaskState(task({ finishedAtMs: 1, exitCode: null })), "signal");
});

test("a task the user stopped stays stopped when its process settles", () => {
  assert.equal(bgTaskState(task({ finishedAtMs: 1, exitCode: null, killedByUser: true })), "stopped");
  assert.equal(bgTaskState(task({ finishedAtMs: 1, exitCode: 1, killedByUser: true })), "stopped");
});
