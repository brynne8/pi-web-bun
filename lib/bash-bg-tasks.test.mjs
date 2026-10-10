import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  bgLogPath,
  pruneBgLogs,
} = await createJiti(import.meta.url).import("./bash-bg-tasks.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

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
