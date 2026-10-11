import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  bgLogPath,
  createBgTaskNotifier,
  pruneBgLogs,
} = await createJiti(import.meta.url).import("./bash-bg-tasks.ts");
const { BG_TASK_NOTIFICATION_CUSTOM_TYPE } = await createJiti(import.meta.url).import("./bg-task-notification.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a finished task reports itself, as `reportBgTask()` builds it in `project-command-env.ts`. */
const outcome = (overrides = {}) => ({
  command: "bun test",
  logPath: "/tmp/pi-web-bg-tasks/task.log",
  startedAtMs: 1_700_000_000_000,
  finishedAtMs: 1_700_000_012_000,
  exitCode: 0,
  ...overrides,
});

/** A sink that records what it was handed, rather than batching it into a queue. */
function recordingSink() {
  const delivered = [];
  return { delivered, sink: { deliver: async (sessionId, report) => { delivered.push({ sessionId, report }); } } };
}

/** A parent session, with the order it was touched in. Only what the notifier reads is here. */
function hostSession({ alive = true } = {}) {
  const order = [];
  return {
    order,
    isAlive: () => alive,
    waitUntilReady: async () => { order.push("waitUntilReady"); },
    inner: { sendCustomMessage: async () => { order.push("sendCustomMessage"); } },
  };
}

function notifierDependencies(session) {
  const reopened = [];
  return {
    reopened,
    deps: {
      getSession: () => session,
      resolveSessionPath: async () => "/tmp/parent.jsonl",
      reopenSession: async (sessionId, sessionFile) => { reopened.push([sessionId, sessionFile]); return session; },
    },
  };
}

/** A task log whose last write is `ageMs` old. */
async function agedLog(dir, name, ageMs) {
  const path = join(dir, name);
  await writeFile(path, "output\n");
  const written = new Date(Date.now() - ageMs);
  await utimes(path, written, written);
  return path;
}

test("drops a task log a day past its last write and keeps a recent one", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bg-prune-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const expired = await agedLog(dir, "yesterday.log", DAY_MS + DAY_MS / 2);
  const recent = await agedLog(dir, "today.log", DAY_MS - 1000);

  pruneBgLogs(dir);

  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(recent), true);
});

test("the sweep touches only task logs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bg-prune-foreign-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const foreign = await agedLog(dir, "notes.txt", DAY_MS * 7);

  pruneBgLogs(dir);

  assert.equal(existsSync(foreign), true);
});

test("handing out a log path sweeps the shared log directory", async () => {
  const dir = join(tmpdir(), "pi-web-bg-tasks");
  await mkdir(dir, { recursive: true });
  const expired = await agedLog(dir, `sweep-probe-${Date.now().toString(36)}.log`, DAY_MS * 2);

  const logPath = bgLogPath();

  assert.equal(existsSync(expired), false);
  assert.ok(logPath.startsWith(`${dir}${sep}`));
  assert.ok(logPath.endsWith(".log"));
});

test("a finished task's report reaches the sink as one bash report", async () => {
  // The one jump that had no test at all: the notifier is the bash side's only call site into the
  // settled-report sink, so a change to what it hands over would silently reach the batch — and
  // the pending index, and the card — with nothing failing.
  const { deps, reopened } = notifierDependencies(hostSession());
  const { sink, delivered } = recordingSink();
  const notifier = createBgTaskNotifier(deps, sink);
  const text = "Background bash task completed in 12s.\nCommand: bun test\nLog file: /tmp/pi-web-bg-tasks/task.log";

  await notifier.notify("parent-1", text, outcome());

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessionId, "parent-1", "the report belongs to the session that ran the task");
  assert.equal(reopened.length, 0, "a live parent is used as it is");
  const report = delivered[0].report;
  assert.equal(report.kind, "bash");
  assert.equal(report.id, "task.log", "the log's own name, which is what the fetch hint reads back");
  assert.equal(report.title, "bun test", "the command's first line, so the parent recognizes it");
  assert.equal(report.outcome, "completed");
  assert.equal(report.finishedAtMs, 1_700_000_012_000);
  assert.equal(report.customType, BG_TASK_NOTIFICATION_CUSTOM_TYPE, "the card this report always had");
  assert.equal(report.fetchHint, 'read("/tmp/pi-web-bg-tasks/task.log")');
  assert.equal(report.text, text, "the built report itself, never a second copy of it");
});

test("the report says how the task ended, in the words the pending index uses", async () => {
  // The index's `outcome` and the report's status line are the same words by construction, and
  // both come from the notifier: a task killed by a signal reads differently from one that
  // failed to spawn, and the parent decides whether to fetch on that difference.
  const cases = [
    [{ exitCode: 0 }, "completed"],
    [{ exitCode: 3 }, "exited with code 3"],
    [{ exitCode: null }, "terminated by a signal"],
    [{ exitCode: null, error: "spawn bun ENOENT" }, "failed (spawn bun ENOENT)"],
  ];
  for (const [overrides, expected] of cases) {
    const { deps } = notifierDependencies(hostSession());
    const { sink, delivered } = recordingSink();
    await createBgTaskNotifier(deps, sink).notify("outcome-parent", "Background bash task", outcome(overrides));
    assert.equal(delivered[0].report.outcome, expected);
  }
});

test("a command's title is its first line, however long the command is", async () => {
  // The index lists titles, and a multi-line command would push every other row off the screen.
  const { deps } = notifierDependencies(hostSession());
  const { sink, delivered } = recordingSink();
  const command = `cd app\n  bun test --watch\necho done`;

  await createBgTaskNotifier(deps, sink).notify("title-parent", "Background bash task", outcome({ command }));

  assert.equal(delivered[0].report.title, "cd app");
});

test("a released parent is reopened and settled before the report is queued", async () => {
  // A wrapper is released when its session goes idle, which is exactly when a long task
  // finishes. The notifier brings the session back by id and waits for it, or the batch would be
  // queued into a session that is not ready to take it.
  const reopened = hostSession();
  const { deps, reopened: reopenedWith } = notifierDependencies(hostSession({ alive: false }));
  deps.reopenSession = async (sessionId, sessionFile) => { reopenedWith.push([sessionId, sessionFile]); return reopened; };
  const { sink, delivered } = recordingSink();

  await createBgTaskNotifier(deps, sink).notify("parent-2", "Background bash task", outcome());

  assert.deepEqual(reopenedWith, [["parent-2", "/tmp/parent.jsonl"]]);
  assert.deepEqual(reopened.order, ["waitUntilReady"], "settled before anything is queued");
  assert.equal(delivered.length, 1);
});

test("a session with no file left on disk drops the report instead of throwing", async () => {
  // A session deleted while its task ran has nowhere to deliver to. The caller is the task's own
  // completion path, where a throw is caught and logged — but the batch must not be half-built.
  const { sink, delivered } = recordingSink();
  const notifier = createBgTaskNotifier({
    getSession: () => undefined,
    resolveSessionPath: async () => null,
    reopenSession: async () => { throw new Error("must not reopen"); },
  }, sink);

  await notifier.notify("gone-parent", "Background bash task", outcome());

  assert.equal(delivered.length, 0);
});
