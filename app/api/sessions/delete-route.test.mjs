import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: deleteSessionsRoute } = await jiti.import("./delete/route.ts");
const { MAX_SESSION_DELETE_IDS } = await jiti.import("../../../lib/session-delete.ts");
const { PROJECT_DELETE_IDS_PER_REQUEST } = await jiti.import("../../../lib/sidebar-actions.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const {
  readSessionUiState,
  resetSessionUiStateCacheForTests,
  updateSessionUiState,
} = await jiti.import("../../../lib/session-ui-state.ts");

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };
const TIME = "2026-10-01T00:00:00.000Z";

function post(body, headers = JSON_HEADERS) {
  return deleteSessionsRoute(new Request("http://localhost/api/sessions/delete", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** A session file as pi writes it: header, then one exchange; a subagent's carries pi-web's meta entry. */
async function writeSession(dir, name, { id, cwd, parentSession, subagentOf }) {
  const path = join(dir, `${name}.jsonl`);
  const lines = [{ type: "session", version: 3, id, timestamp: TIME, cwd, ...(parentSession ? { parentSession } : {}) }];
  if (subagentOf) {
    lines.push({
      type: "custom",
      customType: "pi-web:subagent",
      id: `${id}-meta`,
      parentId: null,
      timestamp: TIME,
      data: { version: 1, parentSessionId: subagentOf.id, parentSessionPath: subagentOf.path, profile: "Explore", description: "Look around" },
    });
  }
  lines.push(
    { type: "message", id: `${id}-u`, parentId: lines.at(-1).id ?? null, timestamp: TIME, message: { role: "user", content: `hello ${name}`, timestamp: Date.parse(TIME) } },
    { type: "message", id: `${id}-a`, parentId: `${id}-u`, timestamp: TIME, message: { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.parse(TIME) } },
  );
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

async function scratchAgentDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  resetSessionUiStateCacheForTests();
  const ids = [];
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    resetSessionUiStateCacheForTests();
    await rm(dir, { recursive: true, force: true });
  });
  const sessionsDir = join(dir, "sessions", "--work-alpha--");
  await mkdir(sessionsDir, { recursive: true });
  return { dir, sessionsDir, ids };
}

test("deletes a project's sessions in one request, with their subagents, keeping a run and re-pointing what stays", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const keepRoot = await writeSession(sessionsDir, "keep-root", { id: "keep-root", cwd });
  const a = await writeSession(sessionsDir, "a", { id: "del-a", cwd, parentSession: keepRoot });
  const b = await writeSession(sessionsDir, "b", { id: "del-b", cwd, parentSession: a });
  const aSub = await writeSession(sessionsDir, "a-sub", { id: "del-a-sub", cwd, parentSession: a, subagentOf: { id: "del-a", path: a } });
  // A fork of b that the confirmation did not count (another window made it):
  // it stays, re-pointed past b and a to the nearest ancestor left.
  const keepFork = await writeSession(sessionsDir, "keep-fork", { id: "keep-fork", cwd, parentSession: b });
  const running = await writeSession(sessionsDir, "running", { id: "run-x", cwd });
  ids.push("keep-root", "del-a", "del-b", "del-a-sub", "keep-fork", "run-x");

  const shutdowns = [];
  const wrapper = (id, isRunning) => ({
    sessionId: id,
    isRunning: () => isRunning,
    isAwaitingInput: () => false,
    shutdown: async () => { shutdowns.push(id); globalThis.__piSessions.delete(id); },
  });
  // run-x started running after the confirmation; del-b is open and idle.
  globalThis.__piSessions.set("run-x", wrapper("run-x", true));
  globalThis.__piSessions.set("del-b", wrapper("del-b", false));
  await updateSessionUiState({ action: "set", ids: ["del-a", "keep-root"], pinned: true });
  await updateSessionUiState({ action: "set", ids: ["del-b"], archived: true });

  const response = await post({ ids: ["del-a", "del-b", "run-x", "gone-elsewhere"] });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json();
  assert.deepEqual(result.deleted.toSorted(), ["del-a", "del-a-sub", "del-b"]);
  assert.deepEqual(result.running, ["run-x"]);
  assert.deepEqual(result.missing, ["gone-elsewhere"]);
  for (const path of [a, b, aSub]) assert.equal(existsSync(path), false, path);
  for (const path of [keepRoot, keepFork, running]) assert.equal(existsSync(path), true, path);
  // The running session was left alone; the idle one was shut down before its file went.
  assert.deepEqual(shutdowns, ["del-b"]);
  assert.ok(globalThis.__piSessions.has("run-x"));

  const forkHeader = JSON.parse(readFileSync(keepFork, "utf8").split("\n")[0]);
  assert.equal(forkHeader.parentSession, keepRoot);
  // Pins and archive times go with the sessions; the others stay.
  assert.deepEqual(Object.keys(readSessionUiState().sessions), ["keep-root"]);
});

test("what stays is re-pointed at its nearest ancestor left, or loses a parent none of whose ancestors stay", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const root = await writeSession(sessionsDir, "root", { id: "del-root", cwd });
  const middle = await writeSession(sessionsDir, "middle", { id: "keep-middle", cwd, parentSession: root });
  const child = await writeSession(sessionsDir, "child", { id: "del-child", cwd, parentSession: middle });
  const grandchild = await writeSession(sessionsDir, "grandchild", { id: "keep-grandchild", cwd, parentSession: child });
  // A subagent of keep-middle whose header names the deleted child: its meta follows the header.
  const sub = await writeSession(sessionsDir, "sub", { id: "keep-sub", cwd, parentSession: child, subagentOf: { id: "keep-middle", path: middle } });
  ids.push("del-root", "keep-middle", "del-child", "keep-grandchild", "keep-sub");

  const result = await (await post({ ids: ["del-root", "del-child"] })).json();

  assert.deepEqual(result.deleted.toSorted(), ["del-child", "del-root"]);
  assert.equal(existsSync(root) || existsSync(child), false);
  const lines = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // Nothing above the deleted root stays: the header loses its parent.
  assert.equal("parentSession" in lines(middle)[0], false);
  assert.equal(lines(grandchild)[0].parentSession, middle);
  const [subHeader, subMeta, ...subRest] = lines(sub);
  assert.equal(subHeader.parentSession, middle);
  assert.deepEqual([subMeta.data.parentSessionId, subMeta.data.parentSessionPath], ["keep-middle", middle]);
  assert.equal(subRest.length, 2, "the rest of the file is kept");
});

test("a delete that empties a folder removes the folder; a folder a file stayed in is kept", async (t) => {
  const { dir, sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const keep = await writeSession(sessionsDir, "keep", { id: "keep-1", cwd });
  const gone = await writeSession(sessionsDir, "gone", { id: "del-gone", cwd });
  // A second project whose every session goes, a subagent with its root:
  // the folder itself goes with them.
  const betaDir = join(dir, "sessions", "--work-beta--");
  await mkdir(betaDir, { recursive: true });
  const b1 = await writeSession(betaDir, "b1", { id: "del-b1", cwd: "/work/beta" });
  const b2 = await writeSession(betaDir, "b2", { id: "del-b2", cwd: "/work/beta", parentSession: b1, subagentOf: { id: "del-b1", path: b1 } });
  ids.push("keep-1", "del-gone", "del-b1", "del-b2");

  const result = await (await post({ ids: ["del-gone", "del-b1"] })).json();

  assert.deepEqual(result.deleted.toSorted(), ["del-b1", "del-b2", "del-gone"]);
  for (const path of [gone, b1, b2]) assert.equal(existsSync(path), false, path);
  assert.equal(existsSync(betaDir), false, "the folder the delete emptied is gone");
  assert.equal(existsSync(sessionsDir), true, "the folder that kept a session stays");
  assert.equal(existsSync(keep), true);
});

test("a folder that gains a session while the delete runs is kept", async (t) => {
  const { sessionsDir, ids } = await scratchAgentDir(t);
  const cwd = "/work/alpha";
  const a = await writeSession(sessionsDir, "a", { id: "del-a", cwd });
  const b = await writeSession(sessionsDir, "b", { id: "del-b", cwd });
  ids.push("del-a", "del-b");
  // An idle wrapper whose shutdown writes a fresh session into the folder:
  // the concurrent-create case. The delete unlinks only its own files, and
  // the now non-empty folder must stay with the file that arrived.
  globalThis.__piSessions.set("del-b", {
    sessionId: "del-b",
    isRunning: () => false,
    isAwaitingInput: () => false,
    shutdown: async () => {
      globalThis.__piSessions.delete("del-b");
      await writeSession(sessionsDir, "late", { id: "late-x", cwd });
    },
  });

  const result = await (await post({ ids: ["del-a", "del-b"] })).json();

  assert.deepEqual(result.deleted.toSorted(), ["del-a", "del-b"]);
  for (const path of [a, b]) assert.equal(existsSync(path), false, path);
  assert.equal(existsSync(sessionsDir), true, "a session won the folder during the delete");
  assert.equal(existsSync(join(sessionsDir, "late.jsonl")), true);
});

test("a delete request must be a trusted JSON list of session ids, at most one part", async (t) => {
  await scratchAgentDir(t);
  assert.equal(MAX_SESSION_DELETE_IDS, PROJECT_DELETE_IDS_PER_REQUEST, "the sidebar's parts fit the route");

  assert.equal((await post({ ids: ["a"] }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post({ ids: ["a"] }, { host: "evil.example", "Content-Type": "application/json" })).status, 403);
  for (const body of ["{", [], { ids: [] }, { ids: "a" }, { ids: ["../a"] }, { ids: [1] }, { ids: Array.from({ length: MAX_SESSION_DELETE_IDS + 1 }, (_, index) => `s${index}`) }]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(typeof (await response.json()).error, "string");
  }
  // Ids already gone delete nothing and say so.
  const response = await post({ ids: ["nobody", "nobody"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: [], missing: ["nobody"], running: [] });
});
