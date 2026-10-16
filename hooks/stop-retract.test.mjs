import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Stop on a run that never answered its prompt: the wrapper moves pi's leaf back over that
// prompt (lib/rpc-manager.test.mjs) and the composer gets the words back. This is the client
// half — the text and the images it was submitted with go back to the input, the transcript is
// read at the moved leaf, and a message that was queued into the run still gets its own run.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
// tryNative: false — Bun imports the hook's .ts natively and answers its `react` import from
// node_modules, so jiti's alias to the hook shim would never apply. One process and one module
// registry for the whole suite means an earlier file may already hold a copy with the real
// React, so drop it. See docs/agents/tests.md.
const nodeRequire = createRequire(import.meta.url);
for (const id of ["./useAgentSession.ts"]) {
  delete nodeRequire.cache[realpathSync(fileURLToPath(new URL(id, import.meta.url)))];
}
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, tryNative: false, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

const originals = {
  document: globalThis.document,
  window: globalThis.window,
  fetch: globalThis.fetch,
  EventSource: globalThis.EventSource,
};
after(() => {
  Object.assign(globalThis, originals);
});

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise((resolve) => setImmediate(resolve)); };

const SESSION = { id: "s1", cwd: "/project", path: "/tmp/s1.jsonl", mtime: 1, size: 1, name: undefined };

/**
 * Mounts a composer on an existing session, sends `submitted`, then presses Stop and answers
 * with `abortReply`. Returns what the composer was handed and the requests the hook made.
 * With `stopDuringSend`, Stop is pressed in the same tick as Enter.
 */
async function stopAfterSend(submitted, abortReply, { stopDuringSend = false } = {}) {
  const commands = [];
  const reads = [];
  const sources = [];
  const restored = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init?.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith("/api/sessions/s1")) {
      reads.push(url);
      return json({ session: SESSION, context: { messages: [], entryIds: [] }, leafId: "e0", tree: [] });
    }
    if (url === "/api/agent/s1/running") return json({ running: false });
    if (url === "/api/agent/s1" && command) {
      commands.push(command);
      if (command.type === "abort") return json({ success: true, data: abortReply });
      return json({ success: true, data: null });
    }
    if (url === "/api/agent/s1") return json({ running: false, state: { isStreaming: false } });
    throw new Error(`unexpected fetch ${url} ${init?.body ?? ""}`);
  };

  const chatInputRef = {
    current: {
      restoreSubmission: (text, images, draftKey) => restored.push({ text, images, draftKey }),
      insertText: () => {},
      insertIfEmpty: () => {},
      replaceMessage: () => {},
      prependText: () => {},
      addImages: () => {},
      rekeyDraft: () => {},
    },
  };

  const hook = renderHook(useAgentSession, {
    session: SESSION,
    sessionRunning: false,
    newSessionCwd: null,
    newSessionDraftKey: null,
    chatInputRef,
  });
  await settle();
  hook.flush();
  const originalError = console.error;
  console.error = () => {};
  try {
    const sending = hook.result.handleSend(submitted.text, submitted.images);
    if (stopDuringSend) void hook.result.handleAbort();
    await settle();
    sources.at(-1)?.connect();
    await settle();
    await sending;
    await settle();
    if (!stopDuringSend) await hook.result.handleAbort();
    await settle();
  } finally {
    console.error = originalError;
    for (const source of sources) source.close();
    hook.unmount();
  }
  return { commands, reads, restored };
}

const EMPTY_QUEUE = { steering: [], followUp: [] };
const IMAGE = { data: "aGVsbG8=", mimeType: "image/png" };

test("Stop on a run with no reply puts its prompt back in the composer with its images", async () => {
  const { commands, reads, restored } = await stopAfterSend(
    { text: "重新弄一下", images: [IMAGE] },
    { queuedMessages: EMPTY_QUEUE, retractedPrompt: { entryId: "e2", text: "重新弄一下" } },
  );

  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort"]);
  // The words come back as the session file has them, with the images the browser still holds.
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, "重新弄一下");
  assert.deepEqual(restored[0].images, [{ data: IMAGE.data, mimeType: IMAGE.mimeType }]);
  // No draft key is passed: a fresh session's promotion rekeys the stored draft to the real
  // session id, and a restore aimed at the old key lands where no composer reads it.
  assert.equal(restored[0].draftKey, undefined);
  // The transcript is read again, so the prompt and its empty reply leave the view with the leaf.
  assert.ok(reads.length > 0, "the session is read again after the leaf moved");
});

test("Stop's retract attaches no images to a text it did not submit", async () => {
  const { restored } = await stopAfterSend(
    { text: "重新弄一下", images: [IMAGE] },
    { queuedMessages: EMPTY_QUEUE, retractedPrompt: { entryId: "e2", text: "扩展过的提示词" } },
  );

  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, "扩展过的提示词");
  assert.equal(restored[0].images, undefined);
});

test("Stop pressed the moment Enter was pressed stops that run and takes the prompt back", async () => {
  const { commands, restored } = await stopAfterSend(
    { text: "重新弄一下", images: undefined },
    { queuedMessages: EMPTY_QUEUE, retractedPrompt: { entryId: "e2", text: "重新弄一下" } },
    { stopDuringSend: true },
  );

  // The Stop has no run to name yet, so it waits for the prompt and goes out after it.
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort"]);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].text, "重新弄一下");
});

test("Stop that took a message from the queue sends it and leaves the transcript alone", async () => {
  const { commands, restored } = await stopAfterSend(
    { text: "重新弄一下", images: undefined },
    { queuedMessages: { steering: ["换成中文"], followUp: [] } },
  );

  // The queued text is the run its author meant; the prompt stays where it is.
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "abort", "prompt"]);
  assert.equal(commands[2].streamingBehavior, "steer");
  assert.deepEqual(restored, []);
});
