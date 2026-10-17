import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
import { resetSessionScanIndex } from "../../../../lib/__fixtures__/session-scan-index.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: autoNameSession } = await jiti.import("./auto-name/route.ts");
const { PATCH: renameSession } = await jiti.import("./route.ts");
const {
  invalidateSessionListCache,
  invalidateSessionPathCache,
} = await jiti.import("../../../../lib/session-reader.ts");
const { appendSessionNameSource, readSessionNameRecord } = await jiti.import("../../../../lib/session-name-source.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

// The scan index is a module global, so under a runner that keeps one process for the
// whole suite (Bun) a listing here shares it with every other file's listings. Start and
// end with an empty one, which is what Node's per-file process gives this file.
await resetSessionScanIndex();
after(resetSessionScanIndex);

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** A title model that answers with `title`, calling `onStream` before it does. */
function replyWith(title, onStream) {
  return () => {
    onStream?.();
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: assistantMessage(title) });
    });
    return stream;
  };
}

/** One session file with a first user message, and a live wrapper the route can name through. */
async function scratchSession(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-auto-name-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();

  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "Fix the flaky login test", timestamp: Date.now() });
  const id = manager.getSessionId();
  const path = manager.getSessionFile();
  invalidateSessionListCache();

  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  return {
    manager,
    id,
    path,
    context: { params: Promise.resolve({ id }) },
    url: `http://localhost/api/sessions/${id}`,
    /** The wrapper the route finds already alive, with a title model of `title`. */
    live(title, onStream) {
      globalThis.__piSessions = new Map([[id, {
        isAlive: () => true,
        waitUntilReady: async () => {},
        sessionFile: path,
        inner: {
          sessionManager: manager,
          setSessionName: (name) => manager.appendSessionInfo(name),
          agent: {
            state: {
              systemPrompt: "system",
              model: { provider: "test", id: "test-model" },
              thinkingLevel: "off",
              tools: [],
              messages: [{ role: "user", content: "Fix the flaky login test", timestamp: 1 }],
            },
            getApiKey: async () => undefined,
            streamFunction: replyWith(title, onStream),
          },
        },
      }]]);
    },
  };
}

test("auto-naming keeps a name a person set", async (t) => {
  const scratch = await scratchSession(t);
  const renamed = await renameSession(
    new Request(scratch.url, { method: "PATCH", body: JSON.stringify({ name: "My own title" }) }),
    scratch.context,
  );
  assert.equal(renamed.status, 200);

  let streamed = false;
  scratch.live("Generated title", () => { streamed = true; });

  const response = await autoNameSession(new Request(scratch.url, { method: "POST" }), scratch.context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: "My own title", declined: "user" });
  assert.equal(streamed, false, "a name it must not replace is answered before the title model runs");
  assert.equal(SessionManager.open(scratch.path).getSessionName(), "My own title");
});

test("a rename while the title model runs is not overwritten", async (t) => {
  const scratch = await scratchSession(t);
  scratch.live("Generated title", () => {
    scratch.manager.appendSessionInfo("Renamed mid-run");
    appendSessionNameSource(scratch.manager, "Renamed mid-run", "user");
  });

  const response = await autoNameSession(new Request(scratch.url, { method: "POST" }), scratch.context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: "Renamed mid-run", declined: "user" });

  const reopened = SessionManager.open(scratch.path);
  assert.equal(reopened.getSessionName(), "Renamed mid-run");
  assert.equal(readSessionNameRecord(reopened.getEntries()).source, "user");
});

test("auto-naming replaces a name it wrote itself", async (t) => {
  const scratch = await scratchSession(t);
  scratch.manager.appendSessionInfo("First generated title");
  appendSessionNameSource(scratch.manager, "First generated title", "auto");
  scratch.live("A better title");

  const response = await autoNameSession(new Request(scratch.url, { method: "POST" }), scratch.context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "A better title");

  const reopened = SessionManager.open(scratch.path);
  assert.equal(reopened.getSessionName(), "A better title");
  assert.deepEqual(readSessionNameRecord(reopened.getEntries()), { name: "A better title", source: "auto" });
});

test("auto-naming names a session that has no name", async (t) => {
  const scratch = await scratchSession(t);
  scratch.live("Named from scratch");

  const response = await autoNameSession(new Request(scratch.url, { method: "POST" }), scratch.context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "Named from scratch");
  assert.equal(SessionManager.open(scratch.path).getSessionName(), "Named from scratch");
});

test("a name the pi TUI set, with no record of its own, is kept", async (t) => {
  const scratch = await scratchSession(t);
  scratch.manager.appendSessionInfo("Set in the terminal");
  scratch.live("Generated title");

  const response = await autoNameSession(new Request(scratch.url, { method: "POST" }), scratch.context);
  assert.deepEqual(await response.json(), { title: "Set in the terminal", declined: "user" });
  assert.equal(SessionManager.open(scratch.path).getSessionName(), "Set in the terminal");
});
