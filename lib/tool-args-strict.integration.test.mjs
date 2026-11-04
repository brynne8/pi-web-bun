import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-strict-args-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createStrictToolArgsExtension } = await jiti.import("./tool-args-strict.ts");

const probeTool = (name, parameters) => ({
  name: "registers-a-probe-tool",
  factory: (pi) => {
    pi.registerTool({
      name,
      label: name,
      description: "Test tool.",
      parameters,
      async execute(_toolCallId, params) {
        return { content: [{ type: "text", text: `ran ${JSON.stringify(params)}` }], details: undefined };
      },
    });
  },
});

const CLOSED = {
  name: "probe",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};
const OPEN = {
  name: "probe_open",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: true,
  },
};

test("a call with a field the schema does not name is blocked, and one without it runs", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-strict-args-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
  const faux = fauxProvider({ models: [{ id: "faux-strict-args" }] });
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
      createStrictToolArgsExtension(),
      probeTool(CLOSED.name, CLOSED.parameters),
      probeTool(OPEN.name, OPEN.parameters),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-strict-args"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  t.after(() => session.dispose());

  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("probe", { name: "a", bogus: 1 }, { id: "call-bogus" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("probe_open", { name: "b", bogus: 1 }, { id: "call-open" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxToolCall("probe", { name: "c" }, { id: "call-clean" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  await session.prompt("use the tools");

  const results = new Map(session.messages
    .filter((message) => message.role === "toolResult")
    .map((message) => [message.toolCallId, message]));
  const textOf = (id) => results.get(id).content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

  assert.equal(results.get("call-bogus").isError, true);
  assert.match(textOf("call-bogus"), /Tool "probe" was called with fields its schema does not define: bogus\./);
  assert.match(textOf("call-bogus"), /Its fields are: name\./);
  // An open schema is left alone, and a call that names only declared fields runs.
  assert.equal(results.get("call-open").isError, false, textOf("call-open"));
  assert.match(textOf("call-open"), /^ran \{"name":"b","bogus":1\}$/);
  assert.equal(results.get("call-clean").isError, false, textOf("call-clean"));
  assert.match(textOf("call-clean"), /^ran \{"name":"c"\}$/);
});
