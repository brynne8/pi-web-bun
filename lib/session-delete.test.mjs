// The delete scan reaches the whole sessions root, not just the folders the
// deleted files sit in: a subagent run with `isolation` gets a worktree as
// its cwd (lib/subagent-runtime.ts), so its file lives in a folder encoded
// from the worktree path — a different folder from its parent's. These cases
// pin that the family and the cascade re-parent find each other across
// folders, and that the widened scan stays bounded: every folder enumerated
// once, every session file read whole at most once.
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { resetSessionScanIndex } from "./__fixtures__/session-scan-index.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { deleteSessions } = await jiti.import("./session-delete.ts");
const { invalidateSessionListCache, invalidateSessionPathCache, listAllSessions } = await jiti.import("./session-reader.ts");
const { resetSessionUiStateCacheForTests } = await jiti.import("./session-ui-state.ts");

// The scan index is a module global, so under a runner that keeps one process
// for the whole suite (Bun) a listing here shares it with every other file's
// listings. Start and end with an empty one, as Node's per-file process does.
await resetSessionScanIndex();
after(resetSessionScanIndex);

const TIME = "2026-10-01T00:00:00.000Z";

/** A session file as pi writes it; `entries` are the lines after the header. */
async function writeSession(dir, name, { id, cwd, parentSession, entries = [] }) {
  const path = join(dir, `${name}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: TIME, cwd, ...(parentSession ? { parentSession } : {}) }, ...entries];
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

const userMsg = (id, name) => ({
  type: "message", id: `${id}-u`, parentId: null, timestamp: TIME,
  message: { role: "user", content: `hello ${name}`, timestamp: Date.parse(TIME) },
});

/** The built-in run's metadata entry, valid for readSubagentRun(). */
const subagentMeta = (id, parent) => ({
  type: "custom", customType: "pi-web:subagent", id: `${id}-meta`, parentId: null, timestamp: TIME,
  data: { version: 1, parentSessionId: parent.id, parentSessionPath: parent.path, profile: "Explore", description: "Look around" },
});

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-family-"));
  const sessionsRoot = join(dir, "sessions");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  resetSessionUiStateCacheForTests();
  const ids = [];
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    resetSessionUiStateCacheForTests();
    // Let a queued index persist land while the env still names this dir.
    await resetSessionScanIndex();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  async function projectFolder(name) {
    const dirPath = join(sessionsRoot, name);
    await mkdir(dirPath, { recursive: true });
    return dirPath;
  }
  return { dir, sessionsRoot, ids, projectFolder };
}

/** The folder a run with `isolation` gets: encoded from the worktree cwd. */
const worktreeFolder = "--work-alpha--worktrees-pi-web-agent-1--";

test("a subagent in its own worktree folder goes with its parent even when the catalogue reads it as something else", async (t) => {
  const { ids, projectFolder } = await scratchAgentDir(t);
  const alphaDir = await projectFolder("--work-alpha--");
  const runDir = await projectFolder(worktreeFolder);
  const parent = await writeSession(alphaDir, "parent", { id: "fam-parent", cwd: "/work/alpha", entries: [userMsg("fam-parent", "parent")] });
  // The isolated run's cwd is the worktree, so its file sits in the folder
  // encoded from that path. Its meta entry sits below the second line, where
  // the list's bounded relation read stops: the catalogue row says "fork",
  // never "subagent", so the family walk alone cannot see this child and the
  // old folder-local scan could not reach this folder either.
  const child = await writeSession(runDir, "run", {
    id: "fam-child", cwd: "/work/alpha/.worktrees/pi-web-agent-1", parentSession: parent,
    entries: [
      { type: "custom", customType: "pi-web:other", id: "noise", parentId: null, timestamp: TIME, data: {} },
      subagentMeta("fam-child", { id: "fam-parent", path: parent }),
      userMsg("fam-child", "child"),
    ],
  });
  ids.push("fam-parent", "fam-child");

  // The very catalogue deleteSessions consults: the child is not a subagent there.
  const catalogue = await listAllSessions({ force: true });
  assert.equal(catalogue.find((session) => session.id === "fam-child")?.relation?.kind, "fork",
    "the catalogue alone cannot tell this child from a fork");

  const result = await deleteSessions(["fam-parent"]);

  assert.deepEqual(result.deleted.toSorted(), ["fam-child", "fam-parent"]);
  assert.equal(fs.existsSync(parent), false, "the parent went");
  assert.equal(fs.existsSync(child), false, "the isolated run went with it");
  assert.equal(fs.existsSync(runDir), false, "the worktree's folder is reclaimed too");
});

test("a survivor in an unrelated folder whose parentSession names a deleted file is re-pointed at the nearest ancestor that stays", async (t) => {
  const { ids, projectFolder } = await scratchAgentDir(t);
  const alphaDir = await projectFolder("--work-alpha--");
  const betaDir = await projectFolder("--work-beta--");
  const runDir = await projectFolder(worktreeFolder);
  const root = await writeSession(alphaDir, "root", { id: "stay-root", cwd: "/work/alpha", entries: [userMsg("stay-root", "root")] });
  const middle = await writeSession(betaDir, "middle", { id: "gone-middle", cwd: "/work/beta", parentSession: root, entries: [userMsg("gone-middle", "middle")] });
  // A worktree-encoded folder naming the deleted middle: outside every
  // folder the delete itself touches, which is what the folder-local re-parent
  // scan used to miss.
  const survivor = await writeSession(runDir, "orphan", {
    id: "stay-orphan", cwd: "/work/alpha/.worktrees/pi-web-agent-1", parentSession: middle,
    entries: [userMsg("stay-orphan", "orphan")],
  });
  ids.push("stay-root", "gone-middle", "stay-orphan");

  const result = await deleteSessions(["gone-middle"]);

  assert.deepEqual(result.deleted, ["gone-middle"]);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(survivor), true);
  const survivorHeader = JSON.parse(readFileSync(survivor, "utf8").split("\n")[0]);
  assert.equal(survivorHeader.parentSession, root, "re-attached past the deleted middle to the root that stays");
});

// The re-parent rewrite replaces the child's file by rename instead of
// truncating it in place: a reader holding the file open keeps the bytes it
// opened, and a process killed during the write leaves the old file whole
// rather than a truncated one.
test("a re-parent rewrite replaces the child file instead of writing it in place", async (t) => {
  const { ids, projectFolder } = await scratchAgentDir(t);
  const alphaDir = await projectFolder("--work-alpha--");
  const root = await writeSession(alphaDir, "root", { id: "atomic-root", cwd: "/work/alpha", entries: [userMsg("atomic-root", "root")] });
  const orphan = await writeSession(alphaDir, "orphan", {
    id: "atomic-orphan", cwd: "/work/alpha", parentSession: root, entries: [userMsg("atomic-orphan", "orphan")],
  });
  ids.push("atomic-root", "atomic-orphan");
  const before = fs.readFileSync(orphan, "utf8");
  const modeBefore = fs.statSync(orphan).mode & 0o777;

  // A reader that opened the child before the delete: with an in-place
  // rewrite this fd would read the rewritten bytes, because writeFileSync
  // truncates the very inode it holds.
  const held = fs.openSync(orphan, "r");
  try {
    const result = await deleteSessions(["atomic-root"]);

    assert.deepEqual(result.deleted, ["atomic-root"]);
    const rewritten = fs.readFileSync(orphan, "utf8");
    assert.equal("parentSession" in JSON.parse(rewritten.split("\n")[0]), false, "the child was re-pointed past the deleted root");
    assert.equal(fs.readFileSync(held, "utf8"), before, "the held fd still reads the original file: the path was replaced, not truncated");
    assert.deepEqual(fs.readdirSync(alphaDir).filter((file) => file.endsWith(".tmp")), [], "no temporary file is left behind");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(orphan).mode & 0o777, modeBefore, "the rewrite kept the child's own mode, not the private 0o600");
    }
  } finally {
    fs.closeSync(held);
  }
});

test("one delete enumerates every folder once and reads every session file whole at most once", async (t) => {
  const { sessionsRoot, ids, projectFolder } = await scratchAgentDir(t);
  const alphaDir = await projectFolder("--work-alpha--");
  const betaDir = await projectFolder("--work-beta--");
  const gammaDir = await projectFolder("--work-gamma--");
  const runDir = await projectFolder(worktreeFolder);
  const cwd = "/work/alpha";
  // The named root, and under it both shapes the widened scan must reach:
  // a child the catalogue misses (meta below line 2) in the worktree folder,
  // and a survivor naming the deleted root from an unrelated folder.
  const root = await writeSession(alphaDir, "root", { id: "del-root", cwd, entries: [userMsg("del-root", "root")] });
  const kept = await writeSession(alphaDir, "kept", { id: "keep-plain", cwd, entries: [userMsg("keep-plain", "kept")] });
  const keptFork = await writeSession(alphaDir, "kept-fork", { id: "keep-fork-of-plain", cwd, parentSession: kept, entries: [userMsg("keep-fork-of-plain", "fork")] });
  const run = await writeSession(runDir, "run", {
    id: "del-run", cwd: "/work/alpha/.worktrees/pi-web-agent-1", parentSession: root,
    entries: [
      { type: "custom", customType: "pi-web:other", id: "noise", parentId: null, timestamp: TIME, data: {} },
      subagentMeta("del-run", { id: "del-root", path: root }),
      userMsg("del-run", "run"),
    ],
  });
  const orphan = await writeSession(gammaDir, "orphan", { id: "keep-orphan", cwd: "/work/gamma", parentSession: root, entries: [userMsg("keep-orphan", "orphan")] });
  const unrelatedSub = await writeSession(betaDir, "quiet-sub", {
    id: "keep-quiet", cwd: "/work/beta", parentSession: kept, entries: [subagentMeta("keep-quiet", { id: "keep-plain", path: kept }), userMsg("keep-quiet", "quiet")],
  });
  ids.push("del-root", "keep-plain", "keep-fork-of-plain", "del-run", "keep-orphan", "keep-quiet");

  // session-delete reads the filesystem through the fs object at call time
  // (docs/agents/tests.md), so these counters are honest on both runners.
  const readdirCalls = [];
  const readFileSyncCalls = [];
  const realReaddirSync = fs.readdirSync;
  const realReadFileSync = fs.readFileSync;
  t.after(() => { fs.readdirSync = realReaddirSync; fs.readFileSync = realReadFileSync; });
  fs.readdirSync = (path, ...rest) => { readdirCalls.push(String(path)); return realReaddirSync(path, ...rest); };
  fs.readFileSync = (path, ...rest) => { readFileSyncCalls.push(String(path)); return realReadFileSync(path, ...rest); };

  const result = await deleteSessions(["del-root"]);

  assert.deepEqual(result.deleted.toSorted(), ["del-root", "del-run"]);
  assert.equal(fs.existsSync(run), false, "the missed child still went with its parent");
  assert.equal(fs.existsSync(orphan), true);
  const orphanHeader = JSON.parse(readFileSync(orphan, "utf8").split("\n")[0]);
  assert.equal("parentSession" in orphanHeader, false, "the orphan's chain holds no survivor: the parent goes");

  const rootRereads = readdirCalls.filter((path) => path === sessionsRoot);
  assert.equal(rootRereads.length, 1, "the sessions root is enumerated once per delete");
  const folderListings = readdirCalls.filter((path) => path !== sessionsRoot && path.startsWith(sessionsRoot + "/"));
  assert.equal(new Set(folderListings).size, folderListings.length, "no project folder is listed twice");
  assert.ok(new Set([alphaDir, betaDir, gammaDir, runDir]).difference(new Set(folderListings)).size === 0,
    "every project folder is reached, not only the deleted file's own");

  const wholeFileReads = readFileSyncCalls.filter((path) => path.endsWith(".jsonl") && path.startsWith(sessionsRoot + "/"));
  assert.equal(new Set(wholeFileReads).size, wholeFileReads.length,
    `each session file is read whole at most once; got ${wholeFileReads.join(", ")}`);
  assert.ok(wholeFileReads.includes(run), "the family probe did read the candidate it had to parse");
  assert.ok(wholeFileReads.includes(orphan), "the re-parent rewrite read its file exactly once, not once per pass");
  for (const untouched of [kept, keptFork, unrelatedSub, root]) {
    assert.equal(wholeFileReads.includes(untouched), false, `${untouched} is settled by its bounded header alone`);
  }
});

// A session's background bash logs go with it (lib/bash-bg-tasks.ts keeps them
// in `<tmpdir>/pi-web-bg-tasks/<sessionId>/`, so the delete can name the
// folder). Without this the log outlives the transcript that names its path.
test("a delete removes the deleted session's background log directory, and no one else's", async (t) => {
  const { ids, projectFolder } = await scratchAgentDir(t);
  const alphaDir = await projectFolder("--work-alpha--");
  const deletedId = randomUUID();
  const keeperId = randomUUID();
  const gone = await writeSession(alphaDir, "gone", { id: deletedId, cwd: "/work/alpha", entries: [userMsg(deletedId, "gone")] });
  const kept = await writeSession(alphaDir, "kept", { id: keeperId, cwd: "/work/alpha", entries: [userMsg(keeperId, "kept")] });
  ids.push(deletedId, keeperId);

  // The real log root: deleteBgLogsForSession resolves BG_LOG_DIR itself, so the
  // fixture is the shared directory, under ids no other run uses.
  const logRoot = join(tmpdir(), "pi-web-bg-tasks");
  const goneDir = join(logRoot, deletedId);
  const keptDir = join(logRoot, keeperId);
  await mkdir(goneDir, { recursive: true });
  await mkdir(keptDir, { recursive: true });
  await writeFile(join(goneDir, "task-a.log"), "output a\n");
  await writeFile(join(keptDir, "task-b.log"), "output b\n");
  t.after(async () => { await rm(goneDir, { recursive: true, force: true }); await rm(keptDir, { recursive: true, force: true }); });

  const result = await deleteSessions([deletedId]);

  assert.deepEqual(result.deleted, [deletedId]);
  assert.equal(fs.existsSync(gone), false);
  assert.equal(fs.existsSync(goneDir), false, "the session's log directory went with it");
  assert.equal(fs.existsSync(join(keptDir, "task-b.log")), true, "another session's logs are untouched");
  assert.equal(fs.existsSync(kept), true);
});
