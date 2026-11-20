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

const GLOBAL_AGENTS = "Global instructions.";
const ANCESTOR_AGENTS = "Instructions for every folder under the root.";
const PROJECT_AGENTS = "Instructions for this project only.";
const PROFILE_PROMPT = "Complete the assigned task.";

// A child runs `noContextFiles` off and keeps only its own folder's file of the SDK's list, so
// it reads the project it works in without the folders that folder sits under — and without the
// global agent dir's file, which the session that delegated to it already carries.
async function runChild(t, { trusted, isolation }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-web-subagent-context-")));
  const worktrees = `${join(root, "project")}-worktrees`;
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(worktrees, { recursive: true, force: true }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; });

  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writeFile(join(agentDir, "agents", "fixture.md"), [
    "---", "description: Context fixture.", "tools: read", "load_skills: false", "load_extensions: false", "max_turns: 1",
    "---", PROFILE_PROMPT,
  ].join("\n"));
  await writeFile(join(agentDir, "AGENTS.md"), GLOBAL_AGENTS);
  await writeFile(join(root, "AGENTS.md"), ANCESTOR_AGENTS);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), PROJECT_AGENTS);
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo project-prefix;" }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Pi Web Test"],
    ["add", "."], ["commit", "-qm", "initial"]]) await exec("git", ["-C", cwd, ...args]);
  if (trusted) new ProjectTrustStore(agentDir).set(cwd, true);

  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({}, { projectTrusted: trusted }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
  });
  const { session: parent } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model: faux.getModel("faux-model"),
  });
  const sessions = new Map();
  let child;
  const registerSession = (inner) => {
    if (inner !== parent) child = inner;
    const wrapper = { inner, cwd, sessionFile: inner.sessionFile ?? "", isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} };
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
    task: "Report.", description: "Context fixture", runInBackground: false, ...(isolation ? { isolation } : {}),
  });
  await execution.completion;
  return { child, parent };
}

test("a child reads its project's own context file, where its parent reads every folder's", async (t) => {
  const { child, parent } = await runChild(t, { trusted: true });
  // The session that delegated keeps pi's full list: the global file, the ancestor's, the project's.
  assert.deepEqual(parent.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content), [
    GLOBAL_AGENTS, ANCESTOR_AGENTS, PROJECT_AGENTS,
  ]);
  assert.deepEqual(child.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content), [PROJECT_AGENTS]);
});

test("an untrusted project's context file reaches the child as it reaches its parent", async (t) => {
  const { child, parent } = await runChild(t, { trusted: false });
  assert.deepEqual(parent.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content), [
    GLOBAL_AGENTS, ANCESTOR_AGENTS, PROJECT_AGENTS,
  ]);
  assert.deepEqual(child.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content), [PROJECT_AGENTS]);
});

test("an isolated child reads the file its worktree checked out, not the folders above it", async (t) => {
  const { child } = await runChild(t, { trusted: true, isolation: "worktree" });
  assert.match(child.sessionManager.getCwd(), /-worktrees[/\\]/);
  const [file] = child.resourceLoader.getAgentsFiles().agentsFiles;
  assert.equal(file.content, PROJECT_AGENTS);
  // The checkout's own file, so the ancestor above the worktrees folder is not it.
  assert.equal(file.path, join(child.sessionManager.getCwd(), "AGENTS.md"));
});

test("a reopened child keeps reading its project's own file", async (t) => {
  const { child } = await runChild(t, { trusted: true });
  const reopened = (await startRpcSession(child.sessionId, child.sessionFile)).session;
  t.after(() => reopened.shutdown());
  await reopened.waitUntilReady();
  assert.deepEqual(reopened.inner.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content), [PROJECT_AGENTS]);
});
