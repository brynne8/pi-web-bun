// The session read the chat opens with (app/api/sessions/[id]/route.ts): the default
// window over a long history, the 404, and the ?force=1 staleness probe against a live
// wrapper. These came out of e2e/run.mjs, where they ran on `fetch` against a live
// server and never touched the browser.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resetSessionScanIndex } from "../../../../lib/__fixtures__/session-scan-index.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./route.ts");
const { AgentSessionWrapper, getRpcSession } = await jiti.import("../../../../lib/rpc-manager.ts");
const {
  invalidateSessionListCache,
  invalidateSessionPathCache,
} = await jiti.import("../../../../lib/session-reader.ts");

// The registry, the scan index and the path cache are module globals: under Bun this
// file shares them with every other file, so start and end with an empty set.
await resetSessionScanIndex();
after(resetSessionScanIndex);

const timestamp = "2026-08-23T00:00:00.000Z";
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-detail-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
invalidateSessionListCache();
after(async () => {
  invalidateSessionListCache();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

async function writeSession(id, entries) {
  const sessionDir = join(agentDir, "sessions", "fixture");
  await mkdir(sessionDir, { recursive: true });
  const file = join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp, cwd: agentDir };
  await writeFile(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  invalidateSessionPathCache(id);
  invalidateSessionListCache();
  return file;
}

const context = (id) => ({ params: Promise.resolve({ id }) });

async function read(id, query = "") {
  const response = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}${query}`),
    context(id),
  );
  assert.equal(response.status, 200, `GET /api/sessions/${id}${query} -> ${response.status}`);
  return response.json();
}

const ids = (start, end) => Array.from({ length: end - start }, (_, i) => `e${start + i}`);
const text = (i) => `Fixture message ${String(i).padStart(4, "0")}`;

test("a 5,000-entry session opens on its last 50 entries and the detail stays bounded", async () => {
  const id = "long-session";
  const entries = Array.from({ length: 5000 }, (_, i) =>
    message(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? "assistant" : "user", text(i)));
  entries.splice(1, 0, message("alternate", "e0", "user", "Alternate history branch"));
  await writeSession(id, entries);

  const detail = await read(id, "?deferThinking=1&deferMedia=1");
  assert.deepEqual(detail.context.entryIds, ids(4950, 5000));
  assert.equal(detail.context.messages.length, 50);
  assert.equal(detail.context.hasMore, true);
  assert.ok(JSON.stringify(detail).length < 100_000, "the detail must not transfer the whole history");
});

test("an unknown session id is a 404, not an empty session", async () => {
  const response = await getSessionDetail(
    new Request("http://localhost/api/sessions/e2e-does-not-exist"),
    context("e2e-does-not-exist"),
  );
  assert.equal(response.status, 404);
});

test("a mount read (?force=1) sees another process's append while an ordinary read keeps the wrapper's snapshot", async (t) => {
  const id = "append-session";
  const file = await writeSession(id, [
    message("root", null, "user", "Wrapper root"),
    message("reply", "root", "assistant", "Wrapper reply"),
  ]);
  // A live wrapper reads its own in-memory index; only the force read probes the file.
  const wrapper = new AgentSessionWrapper({
    sessionId: id,
    sessionFile: file,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    sessionManager: SessionManager.open(file),
    agent: { state: {} },
    dispose() {},
  });
  // Reading the registry creates it on globalThis, which every module copy shares.
  getRpcSession(id);
  globalThis.__piSessions.set(id, wrapper);
  t.after(() => {
    globalThis.__piSessions?.delete(id);
    invalidateSessionPathCache(id);
  });

  assert.deepEqual((await read(id)).context.entryIds, ["root", "reply"], "the wrapper serves its own snapshot first");
  // Another pi process (the TUI) appends to the same session file.
  await appendFile(file, `${JSON.stringify(message("external", "reply", "assistant", "External append"))}\n`);

  const ordinary = await read(id);
  assert.deepEqual(ordinary.context.entryIds, ["root", "reply"], "a post-turn read must not probe disk");
  assert.equal(ordinary.wrapperRebuilt, undefined);

  const forced = await read(id, "?force=1");
  assert.deepEqual(forced.context.entryIds, ["root", "reply", "external"], "a mount read must see the external append");
  assert.equal(forced.wrapperRebuilt, true);

  assert.deepEqual((await read(id)).context.entryIds, ["root", "reply", "external"], "repeated reads must stay stable");
});
