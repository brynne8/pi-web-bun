import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");

test("RPC refuses a malformed subagent resource snapshot instead of reopening it as normal", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-corrupt-subagent-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  try {
    for (const parentSessionId of ["parent", null]) {
      const manager = SessionManager.create(root, sessionDir);
      manager.appendMessage({ role: "user", content: "delegated task", timestamp: Date.now() });
      manager.appendCustomEntry("pi-web:subagent", {
        version: 1,
        parentSessionId,
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "call",
        profile: "general-purpose",
        description: "corrupt",
        task: "task",
        runInBackground: false,
        createdAt: new Date().toISOString(),
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [],
          tools: "read",
          loadSkills: false,
          loadExtensions: false,
        },
      });
      await assert.rejects(
        startRpcSession(manager.getSessionId(), manager.getSessionFile(), undefined),
        /Invalid subagent resource snapshot/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normal sessions load the Read-only MCP policy with the built-ins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  // The Read-only policy for MCP tools rides along with the MCP extension.
  assert.match(startupSource, /\.\.\.\(builtins\?\.extensions \?\? \[\]\),\s*createReadOnlyMcpPolicyExtension\(\),/);
});

test("fork_branch copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork_branch", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), selectedEntryId);
    assert.equal(manager.getLeafId(), selectedEntryId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork before the first message persists a reopenable message-free child session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const settingsEntryId = manager.appendModelChange("test", "test-model");
  const firstEntryId = manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;

    const forked = SessionManager.open(forkedFile, sessionDir);
    assert.equal(forked.getHeader().parentSession, sourceFile);
    assert.equal(forked.getLeafId(), settingsEntryId);
    assert.deepEqual(forked.getEntries(), [manager.getEntry(settingsEntryId)]);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

function assistantFixture(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("fork and fork_branch copy finished entries while the source keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-running-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const firstAssistantId = manager.appendMessage(assistantFixture("first response"));
  // The turn the agent is still running: its user message is already on disk.
  const runningUserId = manager.appendMessage({ role: "user", content: "running prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const sourceBefore = await readFile(sourceFile, "utf8");
  const forkedFiles = [];
  let disposed = false;
  let shutdownEvents = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => { shutdownEvents += 1; } },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const forked = await wrapper.send({ type: "fork", entryId: runningUserId });
    const branched = await wrapper.send({ type: "fork_branch", entryId: firstAssistantId });
    const sessions = await SessionManager.list(root, sessionDir);
    for (const result of [forked, branched]) {
      const info = sessions.find((session) => session.id === result.newSessionId);
      assert.ok(info);
      forkedFiles.push(info.path);
      const child = SessionManager.open(info.path, sessionDir);
      assert.equal(child.getHeader().parentSession, sourceFile);
      assert.equal(child.getLeafId(), firstAssistantId);
      assert.deepEqual(child.getEntries().map((entry) => entry.id), [firstUserId, firstAssistantId]);
    }

    assert.equal(wrapper.isAlive(), true);
    assert.equal(disposed, false);
    assert.equal(shutdownEvents, 0);
    assert.equal(manager.getLeafId(), runningUserId);
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
  } finally {
    wrapper.destroy();
    for (const file of forkedFiles) await unlink(file);
    await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("fork refuses a running shell command and a source not yet written to disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unsaved-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendModelChange("test", "test-model");
  // pi 0.99 writes the file at the first user message. Remove it to exercise
  // the missing-on-disk error without relying on the old flush behavior.
  const userId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  await unlink(sourceFile);
  const inner = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: true,
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );

    inner.isBashRunning = false;
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /has not been saved yet/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork_branch", entryId: userId }),
      /has not been saved yet/,
    );
    assert.equal(wrapper.isAlive(), true);
    assert.deepEqual(await readdir(sessionDir), []);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("session replacement rejects active work and clone writes one reopenable child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseModelRefresh;
  let signalModelRefresh;
  const modelRefreshStarted = new Promise((resolve) => { signalModelRefresh = resolve; });
  const modelRefreshHeld = new Promise((resolve) => { releaseModelRefresh = resolve; });
  let releaseShutdown;
  let signalShutdown;
  const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
  const shutdownHeld = new Promise((resolve) => { releaseShutdown = resolve; });
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.("started");
    }),
    modelRuntime: {
      getModel: () => undefined,
      refresh: async () => {
        signalModelRefresh();
        await modelRefreshHeld;
      },
    },
    extensionRunner: {
      emit: async () => {
        signalShutdown();
        await shutdownHeld;
        throw new Error("fixture shutdown failure");
      },
    },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const modelChange = wrapper.send({ type: "set_model", provider: "test", modelId: "missing" });
    await modelRefreshStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Cannot clone while another session command is running/,
    );
    releaseModelRefresh();
    await assert.rejects(modelChange, /Model not found/);

    await wrapper.send({ type: "prompt", message: "keep this run active" });
    await assert.rejects(
      wrapper.send({ type: "clone", leafId: cloneLeafId }),
      /Cannot clone while the session is running/,
    );
    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));

    const firstClone = wrapper.send({ type: "clone", leafId: cloneLeafId });
    await shutdownStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Session is being copied to a new session/,
    );
    let shutdownErrorLog = "";
    const originalConsoleError = console.error;
    console.error = (...args) => { shutdownErrorLog = args.join(" "); };
    let result;
    try {
      releaseShutdown();
      result = await firstClone;
    } finally {
      console.error = originalConsoleError;
    }
    assert.match(shutdownErrorLog, /clone succeeded, but source session shutdown failed/);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
  } finally {
    wrapper.destroy();
    if (clonedFile) await unlink(clonedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});

test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});

test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    // Since pi 0.99 the first user message already creates the source file.
    assert.deepEqual((await SessionManager.list(root, sessionDir)).map((session) => session.path), [sourceFile]);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("subagents that load resources pass the project trust gate", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /const trustReloadOptions = subagentResources[\s\S]*?subagentLoadsResources[\s\S]*?projectTrustReloadOptions\(sessionCwd, agentDir\)/);
});

test("Stop empties pi's queue before it aborts the run and returns what it held", async () => {
  const calls = [];
  const inner = {
    sessionId: "stop-queue",
    sessionFile: "/tmp/stop-queue.jsonl",
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: { getCwd: () => "/tmp", getSessionName: () => undefined },
    extensionRunner: {},
    agent: { state: {} },
    clearQueue() {
      calls.push("clearQueue");
      return { steering: ["纠正方向"], followUp: ["之后再补一句"] };
    },
    abort() {
      calls.push("abort");
      inner.isStreaming = false;
      return Promise.resolve();
    },
    subscribe: () => () => {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    // The pull happens before Stop and before any await: pi's loop polls steering while it
    // unwinds an aborted tool call, and a message it delivers there gets no answer.
    assert.deepEqual(await wrapper.send({ type: "abort" }), {
      queuedMessages: { steering: ["纠正方向"], followUp: ["之后再补一句"] },
    });
    assert.deepEqual(calls, ["clearQueue", "abort"]);
  } finally {
    wrapper.destroy();
  }
});

/**
 * A session Stop is pressed on, with the real SessionManager so the leaf and the branch are
 * pi's own. `reply` is appended by the fake `abort`, as pi appends the aborted reply while the
 * run unwinds: what the leaf is when Stop arrives is what the retract has to match.
 * `navigateTree` stands in for pi's move over a user entry — the leaf to that entry's parent,
 * its text back for the editor (dist/core/agent-session.js).
 */
async function retractFixture({ entries = [], prompt = "重新弄一下", reply = { role: "assistant", content: [], stopReason: "aborted" }, queued = { steering: [], followUp: [] }, secondBranch = false, unreadable = false }) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-retract-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  for (const message of entries) manager.appendMessage({ ...message, timestamp: Date.now() });
  const priorLeafId = manager.getLeafId();
  const promptEntryId = manager.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
  const navigated = [];
  const inner = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: unreadable ? { getCwd: () => "/tmp", getSessionName: () => undefined } : manager,
    extensionRunner: {},
    agent: { state: {} },
    getActiveToolNames: () => [],
    setActiveToolsByName: () => {},
    clearQueue: () => queued,
    abort: async () => {
      let replyId = null;
      if (reply) replyId = manager.appendMessage({ ...reply, timestamp: Date.now() });
      if (secondBranch) {
        manager.branch(promptEntryId);
        manager.appendMessage({ role: "user", content: "换个说法再来", timestamp: Date.now() });
        manager.branch(replyId);
      }
      inner.isStreaming = false;
    },
    navigateTree: async (targetId) => {
      navigated.push(targetId);
      const target = manager.getEntry(targetId);
      if (target.parentId === null) manager.resetLeaf();
      else manager.branch(target.parentId);
      const content = target.message?.content;
      return { cancelled: false, editorText: typeof content === "string" ? content : "" };
    },
    subscribe: () => () => {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  return { wrapper, manager, promptEntryId, priorLeafId, navigated, root };
}

const abortedEmptyReply = { role: "assistant", content: [], stopReason: "aborted" };

test("Stop takes back the prompt of a run that never answered it, with its branch", async () => {
  const fixture = await retractFixture({
    entries: [{ role: "user", content: "先看一眼" }, { role: "assistant", content: [{ type: "text", text: "看完了" }], stopReason: "stop" }],
  });

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), {
      queuedMessages: { steering: [], followUp: [] },
      retractedPrompt: { entryId: fixture.promptEntryId, text: "重新弄一下" },
    });
    assert.deepEqual(fixture.navigated, [fixture.promptEntryId]);
    // The leaf sits under the answered turn again: the prompt and its empty reply are out of
    // what the next run is given, which is pi's own navigation, not a pi-web edit of the file.
    assert.equal(fixture.manager.getLeafId(), fixture.priorLeafId);
    const context = fixture.manager.buildSessionContext().messages.map((message) => message.role);
    assert.deepEqual(context, ["user", "assistant"]);
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Stop takes back the first prompt of a session to an empty conversation", async () => {
  const fixture = await retractFixture({});
  fixture.manager.branch(fixture.promptEntryId);

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), {
      queuedMessages: { steering: [], followUp: [] },
      retractedPrompt: { entryId: fixture.promptEntryId, text: "重新弄一下" },
    });
    assert.equal(fixture.manager.getLeafId(), null);
    assert.deepEqual(fixture.manager.buildSessionContext().messages, []);
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, reply] of [
  ["an answer", { role: "assistant", content: [{ type: "text", text: "这就来" }], stopReason: "stop" }],
  ["words after a Stop", { role: "assistant", content: [{ type: "text", text: " " }, { type: "text", text: "等一下" }], stopReason: "aborted" }],
  ["a tool call already started", { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }], stopReason: "aborted" }],
  // One thinking block is content: a warm model streams reasoning seconds into the run, and an
  // interrupted thought is still something the author may want to read, so Stop stops and keeps it.
  ["nothing but a thought", { role: "assistant", content: [{ type: "thinking", thinking: "用户想让我", thinkingSignature: "sig" }], stopReason: "aborted" }],
  ["nothing but a blank line", { role: "assistant", content: [{ type: "text", text: " " }], stopReason: "aborted" }],
]) {
  test(`Stop leaves a prompt that got ${name} where it is`, async () => {
    const fixture = await retractFixture({
      entries: [{ role: "user", content: "先看一眼" }, { role: "assistant", content: [{ type: "text", text: "看完了" }], stopReason: "stop" }],
      reply,
    });

    try {
      assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), { queuedMessages: { steering: [], followUp: [] } });
      assert.deepEqual(fixture.navigated, []);
      const roles = fixture.manager.buildSessionContext().messages.map((message) => message.role);
      assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
    } finally {
      fixture.wrapper.destroy();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("Stop leaves a stranded pair that was already there before it", async () => {
  // The case a Stop that started no run sees: the file still ends on an earlier run's prompt
  // and its empty reply, and nothing was appended while this Stop unwound.
  const fixture = await retractFixture({
    entries: [abortedEmptyReply],
    reply: null,
  });
  const leaf = fixture.manager.getLeafId();

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), { queuedMessages: { steering: [], followUp: [] } });
    assert.deepEqual(fixture.navigated, []);
    assert.equal(fixture.manager.getLeafId(), leaf);
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Stop still aborts the run when the session's tree cannot be read", async () => {
  const fixture = await retractFixture({ unreadable: true, reply: null });
  const manager = fixture.manager;
  const leaf = manager.getLeafId();

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), { queuedMessages: { steering: [], followUp: [] } });
    assert.equal(manager.getLeafId(), leaf);
    assert.equal(fixture.navigated.length, 0);
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Stop leaves a prompt another branch already continues", async () => {
  const fixture = await retractFixture({ secondBranch: true });

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), { queuedMessages: { steering: [], followUp: [] } });
    assert.deepEqual(fixture.navigated, []);
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Stop that took a message from the queue sends that and takes no prompt back", async () => {
  const fixture = await retractFixture({ queued: { steering: ["换成中文"], followUp: [] } });
  fixture.manager.branch(fixture.promptEntryId);

  try {
    assert.deepEqual(await fixture.wrapper.send({ type: "abort" }), {
      queuedMessages: { steering: ["换成中文"], followUp: [] },
    });
    assert.deepEqual(fixture.navigated, []);
    // The prompt and its empty reply stay: their author's next message was the queued one.
    assert.deepEqual(
      fixture.manager.buildSessionContext().messages.map((message) => message.role),
      ["user", "assistant"],
    );
  } finally {
    fixture.wrapper.destroy();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
