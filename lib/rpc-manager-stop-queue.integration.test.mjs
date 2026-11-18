import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-stop-queue-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSettledReportSink } = await jiti.import("./settled-report-note.ts");
const { SUBAGENT_META_TYPE, SUBAGENT_RESULT_TYPE } = await jiti.import("./subagents.ts");
test.after(() => rm(agentDir, { recursive: true, force: true }));
const tick = () => new Promise((r) => setTimeout(r, 10));

async function setup(t, steeringMode, options) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-stop-queue-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const gate = { started: false };
  const extension = (pi) => {
    pi.registerTool({
      name: "wait", label: "wait", description: "waits", parameters: { type: "object", properties: {} },
      async execute(_id, _p, signal) {
        gate.started = true;
        await new Promise((resolve) => { signal?.addEventListener("abort", resolve, { once: true }); });
        return { content: [{ type: "text", text: "stopped" }], details: undefined };
      },
    });
  };
  const faux = fauxProvider({ models: [{ id: "faux-stop-queue" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(steeringMode ? { steeringMode } : {});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel("faux-stop-queue"), sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader });
  const wrapper = new AgentSessionWrapper(session, options);
  t.after(() => wrapper.destroy());
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const userTexts = () => session.messages.filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : m.content[0]?.text));
  const settle = async () => { for (let i = 0; i < 300 && (wrapper.isRunning() || !session.isIdle); i += 1) await tick(); };
  return { session, wrapper, faux, gate, userTexts, settle };
}

// Stop lands while a tool runs, with two steers and a follow-up queued. pi's TUI
// clears the queues before it aborts and puts the texts in the editor; left queued,
// the stopped run still sent a steer at its turn boundary (all of them in "all" mode)
// and the rest went out with the next prompt.
for (const mode of ["one-at-a-time", "all"]) {
  test(`Stop returns every queued message and sends none of them (steeringMode ${mode})`, async (t) => {
    const { wrapper, faux, gate, userTexts, settle } = await setup(t, mode);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("reply")]),
    ]);
    await wrapper.send({ type: "prompt", message: "start" });
    while (!gate.started) await tick();
    await wrapper.send({ type: "prompt", message: "s1", streamingBehavior: "steer" });
    await wrapper.send({ type: "prompt", message: "s2", streamingBehavior: "steer" });
    await wrapper.send({ type: "prompt", message: "f1", streamingBehavior: "followUp" });

    assert.deepEqual(await wrapper.send({ type: "abort" }), { queuedMessages: { steering: ["s1", "s2"], followUp: ["f1"] } });
    await settle();
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
    assert.deepEqual(userTexts(), ["start"]);

    await wrapper.send({ type: "prompt", message: "next" });
    await settle();
    assert.deepEqual(userTexts(), ["start", "next"]);
  });
}

test("Stop with nothing queued returns null", async (t) => {
  const { wrapper, faux, gate, settle } = await setup(t);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  await wrapper.send({ type: "prompt", message: "start" });
  while (!gate.started) await tick();
  assert.equal(await wrapper.send({ type: "abort" }), null);
  await settle();
});

// A subagent's parent must not hear that a run ended when the Stop only handed the child's
// queued messages to the next run of the same work, so the wrapper says which Stop this is.
test("Stop tells a subagent's controller whether it handed queued messages to the next run", async (t) => {
  const stops = [];
  const adopted = [];
  const { wrapper, faux, gate, settle } = await setup(t, undefined, {
    onAbortRequested: (stop) => stops.push(stop.handedOver),
    onPromptAccepted: (task) => { adopted.push(task); return undefined; },
  });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  await wrapper.send({ type: "prompt", message: "start" });
  while (!gate.started) await tick();
  assert.equal(await wrapper.send({ type: "abort" }), null);
  await settle();

  gate.started = false;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  await wrapper.send({ type: "prompt", message: "again" });
  while (!gate.started) await tick();
  await wrapper.send({ type: "prompt", message: "s1", streamingBehavior: "steer" });
  assert.deepEqual(await wrapper.send({ type: "abort" }), { queuedMessages: { steering: ["s1"], followUp: [] } });
  await settle();

  assert.deepEqual(stops, [false, true]);

  // The chat sends the texts that Stop took back as the next run, which is a run of its own even
  // though it travels as a steer.
  gate.started = false;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  await wrapper.send({ type: "prompt", message: "s1", streamingBehavior: "steer" });
  assert.deepEqual(adopted, ["start", "again", "s1"], "the continuation is adopted as the run it starts");
  await wrapper.send({ type: "abort" });
  await settle();
});

// The whole point of a handed-over Stop: the work goes on, and the report the parent finally gets
// is the continuation's own — not silence, and not a second "was stopped".
test("a stop that hands its steer texts on still reports the continuation's result to the parent", { timeout: 20_000 }, async (t) => {
  let controller;
  const { session, wrapper, faux, gate, settle } = await setup(t, undefined, {
    onPromptAccepted: (task) => controller.beginDirectPrompt(session.sessionId, task),
    onAbortRequested: (stop) => controller.markRunStopped(session.sessionId, stop.handedOver),
  });
  const sessionId = session.sessionId;
  const delivered = [];
  const parent = {
    inner: { sessionManager: { getSessionId: () => "parent" }, sendCustomMessage: async (message, options) => delivered.push({ message, options }) },
    sessionFile: "/tmp/parent.jsonl",
    cwd: "/tmp",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
  };
  const deps = {
    getSession: (id) => id === sessionId ? wrapper : parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  };
  controller = createSubagentController({ ...deps, settledReports: createSettledReportSink(deps) });
  session.sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, {
    version: 1,
    parentSessionId: "parent",
    parentSessionPath: "/tmp/parent.jsonl",
    parentToolCallId: "fixture-call",
    profile: "general-purpose",
    description: "Stop-and-continue fixture",
    task: "Do the thing",
    runInBackground: true,
    createdAt: new Date().toISOString(),
  });

  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
  await wrapper.send({ type: "prompt", message: "do the thing" });
  while (!gate.started) await tick();
  await wrapper.send({ type: "prompt", message: "also check the parser", streamingBehavior: "steer" });
  assert.deepEqual(await wrapper.send({ type: "abort" }), {
    queuedMessages: { steering: ["also check the parser"], followUp: [] },
  });
  await settle();

  // What the child's chat does with the texts Stop took back.
  faux.setResponses([fauxAssistantMessage([fauxText("PARSER CHECKED")])]);
  await wrapper.send({ type: "prompt", message: "also check the parser", streamingBehavior: "steer" });
  for (let i = 0; i < 300 && delivered.length === 0; i += 1) await tick();
  await settle();

  assert.equal(delivered.length, 1, "the parent hears the continuation once, at its end");
  const text = delivered[0].message.content.map((block) => block.text).join("\n");
  assert.match(text, /Subagent .* completed\./);
  assert.match(text, /PARSER CHECKED/);
  assert.doesNotMatch(text, /was stopped/);
  const results = session.sessionManager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RESULT_TYPE);
  assert.equal(results.length, 1, "the stopped segment left no result of its own");
  assert.equal(results[0].data.status, "completed");
  assert.equal(results[0].data.result, "PARSER CHECKED");
});
