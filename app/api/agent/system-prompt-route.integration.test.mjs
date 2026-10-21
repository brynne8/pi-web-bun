import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

test("a plugin's forced system prompt reaches the state read (#1318)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-system-prompt-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session;
  t.after(async () => {
    await session?.shutdown();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  // A plugin that forces the prompt for every run.
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "extensions", "voice-plugin.ts"),
    `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\nPLUGIN_VOICE_TEXT" }));
}
`,
  );
  await writeFile(join(dir, "settings.json"), "{}");

  const { startRpcSession } = await jiti.import("../../../lib/rpc-manager.ts");
  const started = await startRpcSession("__new__system-prompt", "", dir, {});
  session = started.session;

  const state = await session.send({ type: "get_state" });
  assert.match(state.systemPrompt, /PLUGIN_VOICE_TEXT/);
  // Pi's own prompt is still there under the plugin's text.
  assert.ok(state.systemPrompt.length > 100);

  // A status read leaves the prompt out and asks no plugin for it.
  const status = await session.send({ type: "get_state", includeSystemPrompt: false });
  assert.equal("systemPrompt" in status, false);
});
