import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

/** pi's `compaction_end` for a compaction that produced a summary. */
const compacted = (reason) => ({
  type: "compaction_end",
  reason,
  result: { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 120, estimatedTokensAfter: 40 },
  aborted: false,
  willRetry: false,
});

/** A session whose loader reads the prompt text out of `dir`, with a recorder for the re-render. */
function makeInner(dir, overrides = {}) {
  const reloads = [];
  const renders = [];
  const activeTools = ["read", "bash", "edit", "write"];
  const listeners = new Set();
  const inner = {
    sessionId: "compaction-prompt-text",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: undefined,
    modelRuntime: { getModel: () => undefined, refresh: async () => {} },
    sessionManager: { getCwd: () => dir, getEntries: () => [], getSessionFile: () => undefined },
    settingsManager: { setProjectTrusted: () => {}, getDefaultTools: () => undefined },
    agent: { state: {} },
    extensionRunner: { getRegisteredCommands: () => [], setUIContext: () => {}, emit: async () => {} },
    promptTemplates: [],
    resourceLoader: {
      cwd: dir,
      agentDir: dir,
      noContextFiles: false,
      settingsManager: { isProjectTrusted: () => true },
      appendSystemPrompt: ["stale append"],
      agentsFiles: [{ path: join(dir, "AGENTS.md"), content: "stale context" }],
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    getContextUsage: () => null,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => [...activeTools],
    setActiveToolsByName: (names) => renders.push(names),
    pendingMessageCount: 0,
    dispose: () => {},
    reload: async () => { reloads.push(activeTools); },
    ...overrides,
  };
  return { inner, reloads, renders };
}

async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("a compaction re-reads the prompt text and re-renders the prompt, with the tools unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-compact-prompt-text-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "new rules");
  await writeFile(join(dir, "AGENTS.md"), "new agents");
  const { inner, renders } = makeInner(dir);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());

  inner.emit(compacted("manual"));
  await settle();

  assert.deepEqual(inner.resourceLoader.appendSystemPrompt, ["new rules"]);
  assert.deepEqual(inner.resourceLoader.agentsFiles, [{ path: join(dir, "AGENTS.md"), content: "new agents" }]);
  // The public call that makes pi render the base prompt again, asked for with the tools as they are.
  assert.deepEqual(renders, [["read", "bash", "edit", "write"]]);
});

test("a compaction that failed or was stopped changes no prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-compact-prompt-none-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "new rules");
  const { inner, renders } = makeInner(dir);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());

  inner.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: no model" });
  inner.emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
  await settle();

  assert.deepEqual(inner.resourceLoader.appendSystemPrompt, ["stale append"]);
  assert.deepEqual(renders, []);
});

test("a compaction reloads no extension, setting or MCP server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-compact-prompt-light-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { inner, reloads } = makeInner(dir);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => wrapper.destroy());

  inner.emit(compacted("threshold"));
  await settle();

  // The prompt refresh reads files and re-renders: pi's `reload()` — extensions, `session_start`,
  // MCP servers, settings — is never reached.
  assert.deepEqual(reloads, []);
});
