import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

test("the forced prompt of a plugin is read from the session's extension runner", async () => {
  const { computeForcedSystemPrompt } = await jiti.import("./effective-system-prompt.ts");

  const session = {
    extensionRunner: {
      createCommandContext: () => ({ getSystemPromptOptions: () => ({ cwd: "/tmp" }) }),
      emitBeforeAgentStart: async (_trigger, options) => {
        assert.deepEqual(options, { cwd: "/tmp" });
        return { systemPromptOptions: { forceSystemPrompt: "Pi sections\n\nPLUGIN_TEXT" } };
      },
    },
  };

  assert.equal(await computeForcedSystemPrompt(session), "Pi sections\n\nPLUGIN_TEXT");
});

test("a session without handlers has no forced prompt", async () => {
  const { computeForcedSystemPrompt } = await jiti.import("./effective-system-prompt.ts");

  const session = {
    extensionRunner: {
      createCommandContext: () => ({ getSystemPromptOptions: () => ({ cwd: "/tmp" }) }),
      emitBeforeAgentStart: async () => ({ systemPromptOptions: {} }),
    },
  };

  assert.equal(await computeForcedSystemPrompt(session), undefined);
});

test("a session whose runner cannot answer has no forced prompt", async () => {
  const { computeForcedSystemPrompt } = await jiti.import("./effective-system-prompt.ts");

  assert.equal(await computeForcedSystemPrompt({ extensionRunner: {} }), undefined);
});
