import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

/**
 * A session over `dir`, with a probe that records the prompt of every run as pi renders it for the
 * request. The compaction settings keep nothing recent, so a two-message session can be compacted.
 */
async function startSession(dir, prompts) {
  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const probe = {
    name: "probe",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (_event, ctx) => { prompts.push(ctx.getSystemPrompt()); });
    },
  };
  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 0, reserveTokens: 0 } }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: false,
      extensionFactories: [probe],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
    model: faux.getModel("faux-model"),
  });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  return { faux, wrapper };
}

/** Send a prompt and wait for its run to end: the POST answers at admission, not at the end. */
async function prompt(wrapper, message) {
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("the run did not settle")); }, 15000);
    const off = wrapper.onEvent((event) => {
      if (event.type !== "prompt_done") return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  await wrapper.send({ type: "prompt", message });
  await done;
}

test("a compaction is what makes an edited APPEND_SYSTEM.md reach the model", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-prompt-append-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "rules v1");
  const prompts = [];
  const { faux, wrapper } = await startSession(dir, prompts);
  t.after(() => wrapper.destroy());

  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "hello");
  assert.match(prompts.at(-1) ?? "", /rules v1/);

  // The prompt a session started with stands until a compaction: an edit between two prompts
  // changes nothing, so a run's requests stay identical and the provider cache keeps hitting.
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "rules v2");
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "again");
  assert.match(prompts.at(-1) ?? "", /rules v1/);
  assert.doesNotMatch(prompts.at(-1) ?? "", /rules v2/);

  faux.setResponses([fauxAssistantMessage([fauxText("summary")]), fauxAssistantMessage([fauxText("ok")])]);
  await wrapper.send({ type: "compact" });
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "third");
  assert.match(prompts.at(-1) ?? "", /rules v2/);
});

test("a compaction is what makes an edited AGENTS.md reach the model", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-prompt-agents-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "agents v1");
  const prompts = [];
  const { faux, wrapper } = await startSession(dir, prompts);
  t.after(() => wrapper.destroy());

  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "hello");
  assert.match(prompts.at(-1) ?? "", /agents v1/);

  await writeFile(join(dir, "AGENTS.md"), "agents v2");
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "again");
  assert.doesNotMatch(prompts.at(-1) ?? "", /agents v2/);

  faux.setResponses([fauxAssistantMessage([fauxText("summary")]), fauxAssistantMessage([fauxText("ok")])]);
  await wrapper.send({ type: "compact" });
  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await prompt(wrapper, "third");
  assert.match(prompts.at(-1) ?? "", /agents v2/);
});
