import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

const { createPlatformInfoExtension } = await createJiti(import.meta.url).import("./platform-info.ts");

// The section is what the model reads, so it is proven where it lands: a probe
// extension loaded after this one reads the chained prompt of a real turn.
test("a real session's system prompt carries the platform section", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-platform-info-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const faux = fauxProvider({ models: [{ id: "faux-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);

  let section = null;
  const probe = {
    name: "probe",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (_event, ctx) => {
        section = /<platform>[\s\S]*?<\/platform>/.exec(ctx.getSystemPrompt())?.[0] ?? null;
      });
    },
  };

  const services = await createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [createPlatformInfoExtension(), probe],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(dir, join(dir, "sessions")),
    model: faux.getModel("faux-model"),
  });
  t.after(() => session.dispose());

  faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await session.prompt("hello");

  assert.match(section ?? "", /^<platform>\n- OS: .+\n<\/platform>$|\n- Interactive terminal shell: /, "the machine's own section reached the prompt");
  assert.ok((section ?? "").includes(`(${process.platform},`), "it names the platform this runner is on");
});
