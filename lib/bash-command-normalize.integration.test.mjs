import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-cd-strip-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createBashCommandNormalizeExtension } = await jiti.import("./bash-command-normalize.ts");

/** A `bash` that reports the arguments it was given instead of running a shell. */
const recordingBash = {
  name: "records-bash-arguments",
  factory: (pi) => {
    pi.registerTool({
      name: "bash",
      label: "recording bash",
      description: "Test tool.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `ran ${JSON.stringify(params)}` }], details: undefined };
      },
    });
  },
};

const sessionFileOf = async (sessionDir) => {
  const entries = await readdir(sessionDir, { withFileTypes: true });
  const file = entries.find((entry) => entry.name.endsWith(".jsonl"));
  if (file) return join(sessionDir, file.name);
  const folder = entries.find((entry) => entry.isDirectory());
  const files = await readdir(join(sessionDir, folder.name));
  return join(sessionDir, folder.name, files[0]);
};

test("a cd to the working directory is gone from what runs, what is kept and what the model reads next", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-cd-strip-cwd-"));
  const sessionDir = join(cwd, "sessions");
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

  const faux = fauxProvider({ models: [{ id: "faux-cd-strip" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createBashCommandNormalizeExtension({ cwd }),
      recordingBash,
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-cd-strip"),
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  t.after(() => session.dispose());

  const written = `cd ${cwd} && echo hi`;
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("bash", { command: written }, { id: "call-cd" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("run it");

  const result = session.messages.find((message) => message.role === "toolResult");
  // The tool ran the command without the cd to where it already was.
  assert.equal(result.content[0].text, 'ran {"command":"echo hi"}');
  // The assistant message the loop kept carries the same command, so the next
  // request cannot show the model the prefix it wrote.
  const kept = session.messages
    .find((message) => message.role === "assistant")
    .content.find((block) => block.type === "toolCall");
  assert.equal(kept.arguments.command, "echo hi");
  // And the file holds that message, not the one the model wrote.
  const file = await readFile(await sessionFileOf(sessionDir), "utf8");
  assert.equal(file.includes(written), false);
  assert.equal(file.includes('"command":"echo hi"'), true);
  const calls = SessionManager.open(await sessionFileOf(sessionDir)).buildSessionContext().messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "toolCall");
  assert.equal(calls.length, 1);
  assert.equal((calls[0].input ?? calls[0].arguments).command, "echo hi");
});
