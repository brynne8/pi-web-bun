import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// startRpcSession() builds real SDK sessions here; keep them out of ~/.pi.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-bg-tasks-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");

test.after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

/** A real session and the bash tool it registered, with the switch as `bgTasksEnabled` left it. */
async function sessionTool(t, bgTasksEnabled) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-bg-tasks-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "m" }));
  if (bgTasksEnabled !== undefined) {
    const { writeBgTasksEnabled } = await jiti.import("./bg-tasks-settings.ts");
    await writeBgTasksEnabled(bgTasksEnabled, join(agentDir, "settings.json"));
  }
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "a persisted first message", timestamp: Date.now() });
  const { session } = await startRpcSession(manager.getSessionId(), manager.getSessionFile(), undefined);
  t.after(() => session.destroy());
  return { inner: session.inner, bash: session.inner.getAllTools().find((tool) => tool.name === "bash") };
}

test("a session started with the switch on exposes run_in_background on its bash tool", async (t) => {
  const { bash } = await sessionTool(t, true);
  assert.ok(bash, "the session registered a bash tool");
  assert.equal(bash.parameters.properties.run_in_background.type, "boolean");
  assert.match(bash.description, /hands off to the background after 120 seconds/);
});

test("the switch on puts the tool's rules in a <bash_tool> block, not in <rules>", async (t) => {
  const { inner, bash } = await sessionTool(t, true);
  const { computeForcedSystemPrompt } = await jiti.import("./effective-system-prompt.ts");
  const prompt = await computeForcedSystemPrompt(inner);
  const block = (prompt ?? "").match(/<bash_tool>[\s\S]*<\/bash_tool>/)?.[0];
  assert.ok(block, "the prompt carries a block named after the tool the rules belong to");
  assert.match(block, /120 seconds; treat that as a handoff, not a failure/);
  assert.match(block, /NEVER pipe a command through `\| tail`/);
  // Flattening is what the block replaces: pi's `<rules>` list is every tool's advice with no tool
  // to its name, so the bash tool adds nothing to it — only pi's own guideline stays.
  assert.deepEqual(bash.promptGuidelines, ["You can inspect PI_* environment variables for current model and session details."]);
});

test("a session started without the switch has a plain bash tool", async (t) => {
  const { inner, bash } = await sessionTool(t, undefined);
  assert.ok(bash, "the session registered a bash tool");
  assert.equal(Object.keys(bash.parameters.properties).includes("run_in_background"), false);
  const { computeForcedSystemPrompt } = await jiti.import("./effective-system-prompt.ts");
  const prompt = await computeForcedSystemPrompt(inner);
  assert.doesNotMatch(prompt ?? "", /<bash_tool>/);
});
