import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createOmitEmptyToolsExtension, OMIT_EMPTY_TOOLS_EXTENSION_NAME } =
  await jiti.import("./omit-empty-tools.ts");

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-omit-empty-tools-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  return rm(agentDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test("a real session dispatches the request hook and takes the returned payload", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-omit-empty-tools-cwd-"));
  const faux = fauxProvider({ models: [{ id: "faux-omit" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    extensionFactories: [createOmitEmptyToolsExtension()],
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
    model: faux.getModel("faux-omit"),
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
  });

  try {
    // The event name pi dispatches, reached the way the provider call reaches it:
    // core/sdk.js passes `emitBeforeProviderRequest` as the api module's `onPayload`.
    const loaded = resourceLoader.getExtensions().extensions
      .find((extension) => extension.handlers.has("before_provider_request"));
    assert.ok(loaded, `${OMIT_EMPTY_TOOLS_EXTENSION_NAME} registered no request hook`);
    assert.equal(session.extensionRunner.hasHandlers("before_provider_request"), true);

    const sent = await session.extensionRunner.emitBeforeProviderRequest({
      model: "faux-omit",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [],
      stream: true,
    });
    assert.equal("tools" in sent, false, "an empty tools array survived the session's hooks");
    assert.equal(sent.stream, true);
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
