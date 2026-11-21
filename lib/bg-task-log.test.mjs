import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  bgTaskHandle,
  parseBgTaskHandle,
} = await createJiti(import.meta.url).import("./bg-task-handle.ts");
const {
  countBgTaskLogLines,
  newBgLogPath,
  readBgTaskLogSlice,
  resolveBgTaskLogPath,
} = await createJiti(import.meta.url).import("./bg-task-log.ts");

async function logWith(content, sessionId = `session-${Math.random().toString(16).slice(2)}`) {
  const path = newBgLogPath(sessionId);
  await writeFile(path, content);
  return { path, sessionId, handle: bgTaskHandle(path) };
}

test("a handle is the log's own random tail, and resolves back to it", async () => {
  const { path, sessionId, handle } = await logWith("one\ntwo\n");
  assert.match(handle, /^bash-[0-9a-f]{8}$/);
  assert.equal(parseBgTaskHandle(handle), handle.slice("bash-".length));
  assert.equal(parseBgTaskHandle("child-session"), null, "a subagent id is not a bash handle");
  assert.equal(parseBgTaskHandle("bash-XYZ"), null);
  assert.equal(await resolveBgTaskLogPath(sessionId, handle), path);
  // Another session's directory is not searched: the handle names a log inside one session.
  assert.equal(await resolveBgTaskLogPath("someone-else", handle), null);
  assert.equal(await resolveBgTaskLogPath(sessionId, "bash-00000000"), null);
  assert.equal(await resolveBgTaskLogPath(sessionId, "not-a-handle"), null);
});

test("without an offset a slice starts at the log's first line, as read does", async () => {
  const { path } = await logWith("first\nsecond\nthird\n");
  const slice = await readBgTaskLogSlice(path);
  assert.equal(slice.totalLines, 3);
  assert.equal(slice.firstLine, 1);
  assert.equal(slice.lastLine, 3);
  assert.equal(slice.text, "first\nsecond\nthird");
  assert.equal(slice.truncated, false);
});

test("a limit keeps the first lines and says how many are left", async () => {
  const { path } = await logWith("a\nb\nc\nd\n");
  const slice = await readBgTaskLogSlice(path, { limit: 2 });
  assert.equal(slice.text, "a\nb");
  assert.equal(slice.firstLine, 1);
  assert.equal(slice.lastLine, 2);
  assert.equal(slice.totalLines, 4);
  assert.equal(slice.truncated, true, "lines were left below");
});

test("an offset past the log's end reads no lines and says so", async () => {
  const { path } = await logWith("a\nb\n");
  const slice = await readBgTaskLogSlice(path, { offset: 9 });
  assert.deepEqual([slice.text, slice.firstLine, slice.lastLine, slice.totalLines], ["", 9, 8, 2]);
});

test("an offset pages forward and stops at the byte cap", async () => {
  const { path } = await logWith("l1\nl2\nl3\nl4\n");
  const first = await readBgTaskLogSlice(path, { offset: 1, limit: 2 });
  assert.deepEqual([first.firstLine, first.lastLine, first.text], [1, 2, "l1\nl2"]);
  const second = await readBgTaskLogSlice(path, { offset: 3, limit: 2 });
  assert.deepEqual([second.firstLine, second.lastLine, second.text], [3, 4, "l3\nl4"]);

  const long = `${"x".repeat(40)}\n`.repeat(4);
  const { path: capped } = await logWith(long);
  const cut = await readBgTaskLogSlice(capped, { offset: 1, limit: 4, maxBytes: 90 });
  assert.equal(cut.truncated, true, "the range was cut by the byte cap");
  assert.equal(cut.text.split("\n").length, 2);
});

test("a last line without a newline is still a line, and an empty log has none", async () => {
  const { path } = await logWith("a\nb");
  const slice = await readBgTaskLogSlice(path);
  assert.deepEqual([slice.totalLines, slice.text], [2, "a\nb"]);

  const { path: empty } = await logWith("");
  const none = await readBgTaskLogSlice(empty);
  assert.deepEqual([none.totalLines, none.text, none.firstLine], [0, "", 1]);
});

test("a missing log answers null rather than an empty read", async () => {
  const { path } = await logWith("x\n");
  const { rm } = await import("node:fs/promises");
  await rm(path);
  assert.equal(await readBgTaskLogSlice(path), null);
  assert.equal(await countBgTaskLogLines(path), null);
});

test("a settled log's line count is what the pending index prints", async () => {
  assert.equal(await countBgTaskLogLines((await logWith("a\nb\nc\n")).path), 3);
  assert.equal(await countBgTaskLogLines((await logWith("a\nb")).path), 2);
  assert.equal(await countBgTaskLogLines((await logWith("")).path), 0);
});

test("a log under another temp directory is still read by path", async () => {
  // The slice reader takes any path: the extension resolves the handle, this only numbers lines.
  const dir = await mkdtemp(join(tmpdir(), "pi-web-log-slice-"));
  const path = join(dir, "custom.log");
  await writeFile(path, "only\n");
  assert.equal((await readBgTaskLogSlice(path)).totalLines, 1);
});
