import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// #1678: an extension's session_start may wait on a dialog, which only the event stream shows,
// and get_commands waits for session_start. A fresh composer holds the stream while get_commands
// is out and lets go of it after, so a background tab that only typed "/" holds no connection.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
// tryNative: false — Bun imports a .ts file natively and answers its `react` import from
// node_modules, so jiti's alias to the hook shim would never apply and every render would
// fail as an invalid hook call. Bun runs the whole suite in one process with one module
// registry, so a file that ran earlier may already have loaded the hook natively, with the
// real React; drop that copy so this file gets its own.
const nodeRequire = createRequire(import.meta.url);
delete nodeRequire.cache[realpathSync(fileURLToPath(new URL("./useAgentSession.ts", import.meta.url)))];
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, tryNative: false, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
// Bun runs the whole suite in one process with one globalThis: what this file installs is
// restored once its tests have run, so a later file never meets this file's stubs.
const previousEventSource = globalThis.EventSource;
const previousFetch = globalThis.fetch;
after(() => {
  globalThis.EventSource = previousEventSource;
  globalThis.fetch = previousFetch;
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

function setup(props = {}) {
  const sources = [];
  const commands = [];
  const pendingCommands = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
    connect() {
      this.readyState = 1;
      this.emit({ type: "connected", isStreaming: false });
    }
  };
  const responses = { set_tools: { sessionId: "s2", recreated: true } };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url === "/api/agent/new") return json({ sessionId: "s1", model: { provider: "p", modelId: "before" }, thinkingLevel: "low" });
    if (url.startsWith("/api/agent/") && command) {
      commands.push(`${url.slice("/api/agent/".length)} ${command.type}`);
      if (command.type === "get_commands" || command.type === "get_state") {
        const pending = Promise.withResolvers();
        pendingCommands.push({ type: command.type, resolve: (data) => pending.resolve(json({ success: true, data })) });
        return pending.promise;
      }
      return json({ success: true, data: responses[command.type] ?? null });
    }
    return json({});
  };
  const hook = renderHook(useAgentSession, { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:draft", ...props });
  const open = () => sources.filter((source) => source.readyState !== 2).map((source) => source.url.split("?")[0]);
  const answer = (type, data) => {
    const index = pendingCommands.findIndex((pending) => pending.type === type);
    assert.notEqual(index, -1, `no pending ${type}`);
    pendingCommands.splice(index, 1)[0].resolve(data);
  };
  return { hook, sources, commands, open, answer };
}

test("a fresh composer holds the stream while get_commands waits on session_start's dialog, then lets go", async () => {
  const { hook, sources, commands, open, answer } = setup();
  await settle();
  hook.flush();

  const loading = hook.result.loadSlashCommands();
  await settle();
  assert.deepEqual(open(), ["/api/agent/s1/events"]);
  sources[0].connect();
  sources[0].emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Use project defaults?", message: "" });
  await settle();
  hook.flush();
  assert.equal(hook.result.extensionDialog?.id, "ui-1");

  // Answered: the composer reads the state session_start left (it may have picked the model).
  const responding = hook.result.respondToExtensionUi(hook.result.extensionDialog, { confirmed: true });
  await settle();
  hook.flush();
  assert.deepEqual(commands, ["s1 get_commands", "s1 extension_ui_response", "s1 get_state"]);
  answer("get_state", { model: { provider: "p", id: "after" }, thinkingLevel: "high" });
  await responding;
  answer("get_commands", { commands: [{ name: "ext", source: "extension" }] });
  assert.deepEqual((await loading).map((command) => command.name), ["ext"]);
  await settle();
  hook.flush();

  assert.deepEqual(open(), []);
  assert.deepEqual(hook.result.displayModel, { provider: "p", modelId: "after" });
  hook.unmount();
});

test("after a tool change rebuilds a fresh composer's session, get_commands holds the new session's stream", async () => {
  const { hook, sources, commands, open, answer } = setup();
  await settle();
  hook.flush();

  const first = hook.result.loadSlashCommands();
  await settle();
  answer("get_commands", { commands: [] });
  await first;
  await settle();
  assert.deepEqual(open(), []);

  const changing = hook.result.handleToolPresetChange("readonly");
  await settle();
  answer("get_state", {});
  await changing;
  await settle();

  // The rebuilt session's session_start may ask its dialog again: "/" shows it through s2's stream.
  const second = hook.result.loadSlashCommands();
  await settle();
  assert.deepEqual(open(), ["/api/agent/s2/events"]);
  assert.equal(commands.at(-1), "s2 get_commands");
  sources.at(-1).connect();
  answer("get_commands", { commands: [] });
  await second;
  await settle();
  assert.deepEqual(open(), []);
  hook.unmount();
});

test("opening the System or Tools panel on a fresh composer opens no stream", async () => {
  let loadSystemInfo = null;
  const { hook, open, answer, commands } = setup({ onSystemInfoLoaderChange: (loader) => { loadSystemInfo = loader; } });
  await settle();
  hook.flush();
  assert.equal(typeof loadSystemInfo, "function");
  const loading = loadSystemInfo();
  await settle();
  assert.deepEqual(commands, ["s1 get_state", "s1 get_tools"]);
  answer("get_state", {});
  await loading;
  await settle();
  assert.deepEqual(open(), []);
  hook.unmount();
});
