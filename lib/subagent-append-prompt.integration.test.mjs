import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createSubagentController } = await createJiti(import.meta.url).import("./subagent-runtime.ts");
const { startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const exec = promisify(execFile);

const GLOBAL_APPEND = "Global instructions for every session.";
const PROJECT_APPEND = "Project instructions for every session.";
const PROFILE_PROMPT = "Complete the assigned task.";

// A child passes its own `appendSystemPrompt`, which switches the loader's APPEND_SYSTEM.md
// discovery off, so it names the same file the main session reads ahead of the profile's prompt.
async function runChild(t, { trusted, isolation }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-subagent-append-")));
  const worktrees = `${dir}-worktrees`;
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(worktrees, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });

  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "fixture.md"), [
    "---", "description: Append fixture.", "tools: read", "load_skills: false", "load_extensions: false", "max_turns: 1",
    "---", PROFILE_PROMPT,
  ].join("\n"));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), GLOBAL_APPEND);
  await mkdir(join(dir, ".pi"));
  await writeFile(join(dir, ".pi", "APPEND_SYSTEM.md"), PROJECT_APPEND);
  await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo project-prefix;" }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Pi Web Test"],
    ["add", "."], ["commit", "-qm", "initial"]]) await exec("git", ["-C", dir, ...args]);
  if (trusted) new ProjectTrustStore(dir).set(dir, true);

  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory({}, { projectTrusted: trusted }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const { session: parent } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("faux-model"),
  });
  const sessions = new Map();
  let child;
  const registerSession = (inner) => {
    if (inner !== parent) child = inner;
    const wrapper = { inner, cwd: dir, sessionFile: inner.sessionFile ?? "", isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} };
    sessions.set(inner.sessionId, wrapper);
    return wrapper;
  };
  registerSession(parent);
  t.after(() => { for (const { inner } of sessions.values()) inner.dispose(); });
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id), registerSession,
    resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
    reopenSession: async () => { throw new Error("unused"); },
    invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
  });
  faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  const execution = await controller.extensionRuntime.start({
    parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "call", profile: "fixture",
    task: "Report.", description: "Append fixture", runInBackground: false, ...(isolation ? { isolation } : {}),
  });
  await execution.completion;
  return { child, parent, dir };
}

test("a child appends the project file its parent session reads, ahead of the profile prompt", async (t) => {
  const { child, parent, dir } = await runChild(t, { trusted: true });
  assert.deepEqual(parent.resourceLoader.getAppendSystemPrompt(), [PROJECT_APPEND]);
  assert.deepEqual(child.resourceLoader.getAppendSystemPrompt(), [PROJECT_APPEND, PROFILE_PROMPT]);
  assert.equal(child.sessionManager.getCwd(), dir);
});

test("an untrusted folder leaves the child on the global file, as the parent is", async (t) => {
  const { child, parent } = await runChild(t, { trusted: false });
  assert.deepEqual(parent.resourceLoader.getAppendSystemPrompt(), [GLOBAL_APPEND]);
  assert.deepEqual(child.resourceLoader.getAppendSystemPrompt(), [GLOBAL_APPEND, PROFILE_PROMPT]);
});

test("an isolated child reads the file its worktree checked out", async (t) => {
  const { child } = await runChild(t, { trusted: true, isolation: "worktree" });
  assert.match(child.sessionManager.getCwd(), /-worktrees[/\\]/);
  assert.deepEqual(child.resourceLoader.getAppendSystemPrompt(), [PROJECT_APPEND, PROFILE_PROMPT]);
});

test("a reopened child resolves the file again", async (t) => {
  const { child, dir } = await runChild(t, { trusted: true });
  const reopened = (await startRpcSession(child.sessionId, child.sessionFile)).session;
  t.after(() => reopened.shutdown());
  await reopened.waitUntilReady();
  assert.deepEqual(reopened.inner.resourceLoader.getAppendSystemPrompt(), [PROJECT_APPEND, PROFILE_PROMPT]);
  assert.equal(reopened.inner.sessionManager.getCwd(), dir);
});
