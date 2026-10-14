import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  bgLogPath,
  createBgTaskNotifier,
  deleteBgLogsForSession,
  pruneBgLogs,
} = await createJiti(import.meta.url).import("./bash-bg-tasks.ts");
const { BG_TASK_NOTIFICATION_CUSTOM_TYPE } = await createJiti(import.meta.url).import("./bg-task-notification.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

/** The log root the module uses (`<tmpdir>/pi-web-bg-tasks`), rebuilt here rather than exported from it. */
const BG_LOG_DIR = join(tmpdir(), "pi-web-bg-tasks");
/** The bucket for a task whose session id is unknown or unusable. */
const UNASSIGNED = "_unassigned";

/** A session id no other test — and no real session — will ever carry. */
const testSessionId = (label) => `bg-test-${label}-${randomBytes(4).toString("hex")}`;

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
  await age(path, ageMs);
  return path;
}

/** Backdate a path — a directory counts too, which is what a sweep reads off it. */
async function age(path, ageMs) {
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

test("the sweep takes a stale session directory with its logs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-bg-prune-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The layout this replaces: flat logs in the root, named after nothing.
  const flatExpired = await agedLog(dir, "flat-old.log", DAY_MS * 2);
  const flatRecent = await agedLog(dir, "flat-new.log", 1000);
  const gone = join(dir, "session-gone");
  await mkdir(gone, { recursive: true });
  const expired = await agedLog(gone, "task.log", DAY_MS * 2);
  await age(gone, DAY_MS * 2);
  // A session whose task is still writing: the log's own mtime is what keeps it.
  const busy = join(dir, "session-busy");
  await mkdir(busy, { recursive: true });
  const running = await agedLog(busy, "task.log", 1000);

  pruneBgLogs(dir);

  assert.equal(existsSync(flatExpired), false, "a flat log from the old layout goes too");
  assert.equal(existsSync(flatRecent), true);
  assert.equal(existsSync(expired), false);
  assert.equal(existsSync(running), true, "a log a task still writes stays");
  assert.equal(existsSync(busy), true);
  // Emptying it re-stamps the directory, so the directory itself dies on the sweep
  // after its last log went — which is what an old session looks like a day on.
  assert.equal(existsSync(gone), true, "the unlink itself re-stamped the directory");
  await age(gone, DAY_MS * 2);
  pruneBgLogs(dir);
  assert.equal(existsSync(gone), false, "the emptied directory is gone with it");
});

test("handing out a log path sweeps the shared log directory", async (t) => {
  const sessionId = testSessionId("sweep");
  t.after(() => deleteBgLogsForSession(sessionId));
  await mkdir(BG_LOG_DIR, { recursive: true });
  const expired = await agedLog(BG_LOG_DIR, `sweep-probe-${Date.now().toString(36)}.log`, DAY_MS * 2);

  const logPath = bgLogPath(sessionId);

  assert.equal(existsSync(expired), false);
  assert.ok(logPath.startsWith(`${BG_LOG_DIR}${sep}`));
  assert.ok(logPath.endsWith(".log"));
});

test("a task's log lives in its own session's directory", async (t) => {
  // One flat directory could never be traced back to the session that owned the log,
  // so a deleted session left its log behind with its path still named in a report.
  const sessionId = testSessionId("layout");
  const otherId = testSessionId("layout-other");
  t.after(() => deleteBgLogsForSession(sessionId));
  t.after(() => deleteBgLogsForSession(otherId));

  const logPath = bgLogPath(sessionId);
  const otherPath = bgLogPath(otherId);

  assert.equal(dirname(dirname(logPath)), BG_LOG_DIR, "one directory under the log root, never the root itself");
  assert.equal(basename(dirname(logPath)), sessionId);
  assert.equal(basename(dirname(otherPath)), otherId, "two sessions never share a directory");
  assert.ok(existsSync(dirname(logPath)), "the directory is there before the caller opens its stream");
});

test("a task with no usable session id lands in the shared bucket", async (t) => {
  const made = [];
  t.after(async () => {
    for (const path of made) await rm(path, { force: true });
  });
  const unusable = [
    undefined, "", ".", "..", "../escape", `..${sep}..${sep}etc`, "a/b", "a\\b", "~",
    "..unassigned", "_unassigned", "sess ion", "s;rm -rf /", "x".repeat(200),
  ];

  for (const sessionId of unusable) {
    const logPath = sessionId === undefined ? bgLogPath() : bgLogPath(sessionId);
    made.push(logPath);
    assert.equal(dirname(logPath), join(BG_LOG_DIR, UNASSIGNED), `id ${JSON.stringify(sessionId)} never becomes a directory of its own`);
    assert.ok(logPath.startsWith(`${BG_LOG_DIR}${sep}`), "and never leads out of the log root");
  }
});

test("deleting a session removes its log directory, files and all", async () => {
  const sessionId = testSessionId("delete");
  const dir = join(BG_LOG_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "task.log"), "output\n");

  deleteBgLogsForSession(sessionId);

  assert.equal(existsSync(dir), false, "the directory goes with its files");
  // A session that never ran a background command has no directory at all: ENOENT is
  // not an error here, and must not be thrown at a session delete.
  deleteBgLogsForSession(sessionId);
  deleteBgLogsForSession(testSessionId("never-ran"));
});

test("deleteBgLogsForSession refuses anything that is not one safe component", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "pi-web-bg-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const kept = join(outside, "kept.log");
  await writeFile(kept, "not ours\n");
  const bucket = join(BG_LOG_DIR, UNASSIGNED);
  await mkdir(bucket, { recursive: true });
  const bucketLog = join(bucket, `keep-${Date.now().toString(36)}.log`);
  await writeFile(bucketLog, "shared bucket\n");
  t.after(() => rm(bucketLog, { force: true }));

  for (const sessionId of [
    "..", ".", "_unassigned", "", "../pi-web-bg-outside", `..${sep}..`, "a/b", "a\\b",
    "~", "x".repeat(200), outside, `${BG_LOG_DIR}${sep}..`,
  ]) {
    deleteBgLogsForSession(sessionId);
  }

  assert.equal(existsSync(kept), true, "nothing outside the log root is touched");
  assert.equal(existsSync(outside), true);
  assert.equal(existsSync(bucketLog), true, "the shared bucket belongs to no one session");
  assert.equal(existsSync(BG_LOG_DIR), true, "and the log root is never a session's directory");
});

test("a session's log directory is never followed through a symlink", async (t) => {
  const sessionId = testSessionId("symlink");
  const abroad = await mkdtemp(join(tmpdir(), "pi-web-bg-abroad-"));
  t.after(() => rm(abroad, { recursive: true, force: true }));
  const inside = join(abroad, "abroad.log");
  await writeFile(inside, "outside the log root\n");
  const link = join(BG_LOG_DIR, sessionId);
  await mkdir(BG_LOG_DIR, { recursive: true });
  await symlink(abroad, link);
  t.after(() => rm(link, { force: true }));

  deleteBgLogsForSession(sessionId);

  assert.equal(existsSync(link), false, "the link goes");
  assert.equal(existsSync(inside), true, "what it pointed at is not this directory's to delete");
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
