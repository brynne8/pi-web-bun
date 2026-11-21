import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createGetResultExtension } = await jiti.import("./get-result-extension.ts");
const { newBgLogPath } = await jiti.import("./bg-task-log.ts");
const { createProjectCommandBashExtension } = await jiti.import("./project-command-env.ts");
const { bgTaskHandle } = await jiti.import("./bg-task-handle.ts");
const { takeBgTaskResultConsumed, trackBgTask, untrackBgTask, settleBgTask } = await jiti.import("./bash-bg-tasks.ts");

function sessionId() {
  return `session-${Math.random().toString(16).slice(2)}`;
}

async function tools(options) {
  const registered = new Map();
  await createGetResultExtension(options).factory({
    registerTool(tool) { registered.set(tool.name, tool); },
  });
  return registered;
}

async function logIn(session, content) {
  const path = newBgLogPath(session);
  await writeFile(path, content);
  return { path, handle: bgTaskHandle(path) };
}

/** A runtime that answers one settled run, the way the subagent controller does. */
function subagentRuntime(overrides = {}) {
  return {
    async start() { throw new Error("unused"); },
    async get() {
      return {
        sessionId: "child-session",
        sessionPath: "/tmp/child.jsonl",
        parentSessionId: "parent-session",
        parentToolCallId: "call",
        profile: "explore",
        description: "Inspect",
        task: "Inspect",
        runInBackground: true,
        status: "completed",
        createdAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        result: "Parser found",
      };
    },
    async steer() {},
    async notifyParent() {},
    markResultConsumed() {},
    ...overrides,
  };
}

test("with both switches off there is nothing to fetch, so no tool", async () => {
  assert.equal((await tools({ withdraw() {} })).size, 0);
});

test("with only background bash on, the tool offers its parameters and not the subagent's", async () => {
  const registry = await tools({ withdraw() {}, bgTasks: () => true });
  const tool = registry.get("get_result");
  assert.ok(tool, "the command's output still has one way in");
  assert.doesNotMatch(tool.description, /subagent/i);
  assert.match(tool.description, /Never call this on a command that is still running/);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["id", "limit", "offset"]);
  assert.match(tool.parameters.properties.id.description, /bash-3f2a9b1c/);
});

test("with only subagents on, the tool is the report fetch it always was", async () => {
  const registry = await tools({ withdraw() {}, subagents: subagentRuntime() });
  const tool = registry.get("get_result");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["id", "wait", "wait_timeout"]);
  assert.match(tool.description, /Never call this to check or wait for a run/);
  const answer = await tool.execute("call", { id: "child-session" });
  assert.equal(answer.content[0].text, "Subagent child-session completed.\n\nParser found");
  // A handle is refused as the switch, never looked up as a session id.
  const refused = await tool.execute("call", { id: "bash-deadbeef" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Background bash is switched off/);
});

test("with both on, one tool serves both and refuses the half that is off", async () => {
  const both = await tools({ withdraw() {}, bgTasks: () => true, subagents: subagentRuntime() });
  const tool = both.get("get_result");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["id", "limit", "offset", "wait", "wait_timeout"]);
  assert.match(tool.parameters.properties.id.description, /bash-3f2a9b1c/);
  assert.match(tool.parameters.properties.id.description, /8-character/);

  // The other direction: a session id in a session without the subagent switch, and both
  // refusals name the switch rather than pretending the result does not exist.
  const bashOnly = await tools({ withdraw() {}, bgTasks: () => true });
  const noSubagents = await bashOnly.get("get_result").execute("call", { id: "child-session" });
  assert.equal(noSubagents.isError, true);
  assert.match(noSubagents.content[0].text, /Built-in subagents are switched off/);
});

test("a command's output reads as a page of its log, and fetching consumes the report", async () => {
  const session = sessionId();
  const { path, handle } = await logIn(session, "line one\nline two\nline three\n");
  const withdrawn = [];
  const tool = (await tools({
    withdraw: (...args) => withdrawn.push(args),
    bgTasks: () => true,
  })).get("get_result");

  const answer = await tool.execute("call", { id: handle }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(answer.isError, undefined);
  assert.equal(answer.content[0].text, `Background command ${handle}: lines 1-3 of 3.\n\nline one\nline two\nline three`);
  // Reading is seeing: the report queued for this result is taken back out.
  assert.deepEqual(withdrawn, [[session, "bash", handle]]);
  assert.equal(takeBgTaskResultConsumed(handle), true, "the report still on its way is dropped as well");

  const page = await tool.execute("call", { id: handle, offset: 2, limit: 1 }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(page.content[0].text, `Background command ${handle}: lines 2-2 of 3. Read on with offset: 3.\n\nline two`);

  // A page cut short of the end says where to go on; one that reaches the end says nothing.
  const first = await tool.execute("call", { id: handle, limit: 2 }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(first.content[0].text, `Background command ${handle}: lines 1-2 of 3. Read on with offset: 3.\n\nline one\nline two`);
  assert.ok(path.endsWith(`${handle.slice("bash-".length)}.log`));
});

test("a command that is still running answers that it will report on its own", async () => {
  const session = sessionId();
  const { path, handle } = await logIn(session, "still going\n");
  const controller = new AbortController();
  // `background: true`, as `run_in_background` starts one: a foreground entry is not listable.
  trackBgTask(session, controller, { command: "bun run dev", logPath: path, startedAtMs: Date.now(), background: true });
  try {
    const answer = await (await tools({ withdraw() {}, bgTasks: () => true })).get("get_result").execute(
      "call",
      { id: handle },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => session } },
    );
    assert.match(answer.content[0].text, /is still running/);
    assert.equal(takeBgTaskResultConsumed(handle), false, "a running command's report is not consumed");
  } finally {
    settleBgTask(controller, { exitCode: 0 });
    untrackBgTask(session, controller);
  }
});

test("a log the sweep took away, and a handle from another session, are named refusals", async () => {
  const session = sessionId();
  const tool = (await tools({ withdraw() {}, bgTasks: () => true })).get("get_result");
  const missing = await tool.execute("call", { id: "bash-00000000" }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No background command output for bash-00000000/);

  const { path: foreign } = await logIn("another-session", "x\n");
  const elsewhere = await tool.execute("call", { id: bgTaskHandle(foreign) }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(elsewhere.isError, true, "one session does not read another's log");
});

test("the handle a background command hands out is the one get_result reads", async () => {
  // The whole path end to end: the report names a handle (the start text does not), get_result
  // resolves it, and the output the command wrote is what comes back.
  const session = sessionId();
  const started = [];
  const bash = createProjectCommandBashExtension({
    cwd: process.cwd(),
    settings: { getShellCommandPrefix: () => undefined, getShellPath: () => undefined },
    bgTasks: { notify: async (_sessionId, text) => { started.push(text); } },
  });
  let bashTool;
  await bash.factory({ registerTool(tool) { bashTool = tool; } });
  const result = await bashTool.execute(
    "bg-1",
    { command: "echo get-result-works", run_in_background: true },
    undefined,
    undefined,
    { model: undefined, thinkingLevel: "off", sessionManager: { getSessionId: () => session } },
  );
  assert.doesNotMatch(result.content[0].text, /get_result/, "the start text offers no handle");
  assert.doesNotMatch(result.content[0].text, /bash-[0-9a-f]{8}/);

  // Wait for the process to settle and its log to be closed before reading it.
  for (let i = 0; i < 60 && started.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(started.length, 1);
  const handle = /get_result\("(bash-[0-9a-f]{8})"\)/.exec(started[0])?.[1];
  assert.ok(handle, "the report carries the handle");

  const tool = (await tools({ withdraw() {}, bgTasks: () => true })).get("get_result");
  const answer = await tool.execute("call", { id: handle }, undefined, undefined, {
    sessionManager: { getSessionId: () => session },
  });
  assert.equal(answer.isError, undefined);
  assert.match(answer.content[0].text, /get-result-works/);
  assert.doesNotMatch(answer.content[0].text, /Log file/, "the answer never names the log's path");
});
