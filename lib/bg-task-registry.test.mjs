import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getBgTask,
  hasLiveBgTasks,
  killBgTask,
  killBgTasksForSession,
  listBgTasks,
  noteBgTaskOutput,
  promoteBgTask,
  settleBgTask,
  trackBgTask,
  untrackBgTask,
  wasBgTaskKilled,
} = await createJiti(import.meta.url).import("./bg-task-registry.ts");

const testSessionId = (label) => `bg-registry-${label}-${randomBytes(4).toString("hex")}`;

function started(sessionId, overrides = {}) {
  const controller = new AbortController();
  const id = trackBgTask(sessionId, controller, {
    command: "bun run dev",
    logPath: `/tmp/${sessionId}.log`,
    startedAtMs: 1_000,
    background: true,
    ...overrides,
  });
  return { controller, id };
}

test("a foreground command stays out of the panel until it hands off", () => {
  const sessionId = testSessionId("promote");
  const controller = new AbortController();
  const id = trackBgTask(sessionId, controller, { command: "bun test", startedAtMs: 1_000 });

  assert.equal(hasLiveBgTasks(sessionId), true, "a session with a foreground command still has work");
  assert.equal(listBgTasks().some((task) => task.id === id), false, "but it is not a background task yet");

  promoteBgTask(controller, {
    command: "bun test",
    logPath: "/tmp/promoted.log",
    startedAtMs: 1_000,
    trigger: "time",
  });
  const task = getBgTask(id);
  assert.equal(task?.trigger, "time");
  assert.equal(task?.command, "bun test");
  assert.equal(listBgTasks().some((row) => row.id === id), true);

  untrackBgTask(sessionId, controller);
  assert.equal(getBgTask(id), undefined);
});

test("output moves the idle clock, and a finished task stays readable for a while", () => {
  const sessionId = testSessionId("output");
  const { controller, id } = started(sessionId);
  noteBgTaskOutput(controller, 5_000);
  assert.equal(getBgTask(id)?.lastOutputAtMs, 5_000);

  settleBgTask(controller, { exitCode: 0 });
  const finished = getBgTask(id);
  assert.equal(finished?.finishedAtMs !== null, true);
  assert.equal(finished?.exitCode, 0);
  assert.equal(hasLiveBgTasks(sessionId), false, "a finished task is not something to wait for");
});

test("stopping a task aborts it, marks the report as unwanted and leaves the entry until it settles", () => {
  const sessionId = testSessionId("kill");
  const { controller, id } = started(sessionId);
  let aborted = false;
  controller.signal.addEventListener("abort", () => { aborted = true; });

  const stopped = killBgTask(id);
  assert.equal(aborted, true);
  assert.equal(stopped?.killedByUser, true);
  assert.equal(wasBgTaskKilled(controller), true, "the ordinary completion report must step aside");
  assert.equal(getBgTask(id)?.finishedAtMs, null, "the row stays until the process actually ends");

  settleBgTask(controller, { exitCode: null, error: "aborted" });
  assert.equal(getBgTask(id)?.killedByUser, true);
  assert.equal(killBgTask(id), undefined, "a finished task cannot be stopped twice");
});

test("session teardown forgets every task at once", () => {
  const sessionId = testSessionId("teardown");
  const first = started(sessionId);
  const second = started(sessionId);
  killBgTasksForSession(sessionId);

  assert.equal(hasLiveBgTasks(sessionId), false);
  assert.equal(getBgTask(first.id), undefined);
  assert.equal(getBgTask(second.id), undefined);
});
