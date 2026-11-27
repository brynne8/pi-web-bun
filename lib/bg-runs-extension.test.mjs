import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createListBgRunsExtension } = await jiti.import("./bg-runs-extension.ts");
const { newBgLogPath } = await jiti.import("./bg-task-log.ts");
const { bgTaskHandle } = await jiti.import("./bg-task-handle.ts");
const { promoteBgTask, settleBgTask, trackBgTask, untrackBgTask } = await jiti.import("./bash-bg-tasks.ts");

function session() {
  return `session-${Math.random().toString(16).slice(2)}`;
}

async function tools(options) {
  const registered = new Map();
  await createListBgRunsExtension(options).factory({
    registerTool(tool) { registered.set(tool.name, tool); },
  });
  return registered;
}

/** A runtime that lists what it was handed, the way the subagent controller does. */
function subagentRuntime(entries, calls = []) {
  return {
    async start() { throw new Error("unused"); },
    async get() { return null; },
    async list(parentSessionId) { calls.push(parentSessionId); return entries; },
    async steer() {},
    async abort() {},
    async notifyParent() {},
    markResultConsumed() {},
  };
}

function callingSession(sessionId) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

/** A command handed to the background, tracked the way the bash tool does it. */
async function backgroundCommand(sessionId, command, outcome = {}) {
  const controller = new AbortController();
  const logPath = newBgLogPath(sessionId);
  trackBgTask(sessionId, controller, { command, logPath, startedAtMs: Date.now() });
  promoteBgTask(controller, { command, logPath, startedAtMs: Date.now() });
  if (outcome.exitCode !== undefined) settleBgTask(controller, { exitCode: outcome.exitCode });
  return {
    handle: bgTaskHandle(logPath),
    async stop() { untrackBgTask(sessionId, controller); },
  };
}

test("with both switches off there is nothing to list, so no tool", async () => {
  assert.equal((await tools({})).size, 0);
});

test("with background bash off, the tool says a row is a subagent run", async () => {
  const registry = await tools({ subagents: subagentRuntime([]), bgTasks: () => false });
  const tool = registry.get("list_bg_runs");
  assert.ok(tool, "a subagent run still has one way to be found");
  assert.match(tool.description, /Every row is a subagent run\./);
  assert.doesNotMatch(tool.description, /command/i);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["status"]);
});

test("with subagents off, the tool still lists background commands", async () => {
  const registry = await tools({ bgTasks: () => true });
  const tool = registry.get("list_bg_runs");
  assert.ok(tool, "background commands keep their listing with subagents off");
  assert.match(tool.description, /Every row is a background command\./);
  assert.doesNotMatch(tool.description, /subagent/i);
});

test("with both on, the description names the two kinds a row can be", async () => {
  const registry = await tools({ subagents: subagentRuntime([]), bgTasks: () => true });
  const tool = registry.get("list_bg_runs");
  assert.match(tool.description, /A row is a background command \(`bash`\) or a subagent run \(`subagent`\)\./);
  assert.match(tool.description, /its `id` is what `get_result` fetches with/);
  assert.match(tool.description, /The default view is a process list/);
  assert.equal(tool.exposure, "model-only", "a codemode script must not decide when the parent looks");
});

test("one table holds the session's commands and its delegated runs", async () => {
  const parentId = session();
  const otherId = session();
  const running = await backgroundCommand(parentId, "npm run build");
  const finished = await backgroundCommand(parentId, "git push", { exitCode: 0 });
  const elsewhere = await backgroundCommand(otherId, "echo not mine");
  const calls = [];
  const subagents = subagentRuntime([{
    sessionId: "7f2d9c1a-4b3e-4a1f-9c2d-1e2f3a4b5c6d",
    profile: "explore",
    status: "running",
    updatedAt: "2026-01-01T00:00:00.000Z",
    description: "Find parser",
  }], calls);

  const tool = (await tools({ subagents, bgTasks: () => true })).get("list_bg_runs");
  const result = await tool.execute("call", {}, undefined, undefined, callingSession(parentId));

  const lines = result.content[0].text.split("\n");
  assert.equal(lines[0], "id\tkind\tstate\tlast_activity\tdescription");
  assert.match(lines[1], new RegExp(`^${running.handle}\tbash\trunning\t`));
  assert.match(lines[1], /\tnpm run build$/);
  // A subagent's short id is what `get_result` takes, and the profile rides in its description.
  assert.match(result.content[0].text, /^3a4b5c6d\tsubagent\trunning\t.*\texplore: Find parser$/m);
  // A succeeded command is out of the process list and into the note, exactly as a completed run is.
  assert.match(result.content[0].text, /note: 1 completed run not shown/);
  // Another session's command is not this session's business.
  assert.doesNotMatch(result.content[0].text, new RegExp(elsewhere.handle));
  assert.deepEqual(calls, [parentId]);
  assert.equal(result.details.count, 3);

  await running.stop();
  await finished.stop();
  await elsewhere.stop();
});

test("the status parameter reaches the table it filters", async () => {
  const parentId = session();
  const done = await backgroundCommand(parentId, "make", { exitCode: 0 });
  const tool = (await tools({ bgTasks: () => true })).get("list_bg_runs");

  const recent = await tool.execute("call", {}, undefined, undefined, callingSession(parentId));
  assert.doesNotMatch(recent.content[0].text, new RegExp(done.handle));
  assert.match(recent.content[0].text, /1 completed run not shown/);

  const all = await tool.execute("call", { status: "all" }, undefined, undefined, callingSession(parentId));
  assert.match(all.content[0].text, new RegExp(`^${done.handle}\tbash\tsucceeded\t`, "m"));

  await done.stop();
});

test("a command whose session is gone is answered in words", async () => {
  const tool = (await tools({ bgTasks: () => true })).get("list_bg_runs");
  const result = await tool.execute("call", {}, undefined, undefined, callingSession(session()));
  assert.equal(result.content[0].text, "No background runs started by this session.");
});

test("without a session the tool refuses instead of guessing", async () => {
  const tool = (await tools({ subagents: subagentRuntime([]), bgTasks: () => true })).get("list_bg_runs");
  const result = await tool.execute("call", {}, undefined, undefined, undefined);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Cannot list background runs: no session.");
});

test("a runtime that refuses is reported, not thrown", async () => {
  const subagents = subagentRuntime([]);
  subagents.list = async () => { throw new Error("session index unreadable"); };
  const tool = (await tools({ subagents, bgTasks: () => true })).get("list_bg_runs");
  const result = await tool.execute("call", {}, undefined, undefined, callingSession(session()));
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "session index unreadable");
});
