import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { appendSystemPromptSources } = await createJiti(import.meta.url).import("./append-system-prompt.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-append-prompt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { cwd, agentDir };
}

test("the trusted project file wins over the global one", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "project");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global");
  assert.deepEqual(appendSystemPromptSources(cwd, agentDir, true), [join(cwd, ".pi", "APPEND_SYSTEM.md")]);
});

test("an untrusted folder falls back to the global file, as the loader's discovery does", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "project");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global");
  assert.deepEqual(appendSystemPromptSources(cwd, agentDir, false), [join(agentDir, "APPEND_SYSTEM.md")]);
});

test("a trusted folder with no file of its own reads the global one", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global");
  assert.deepEqual(appendSystemPromptSources(cwd, agentDir, true), [join(agentDir, "APPEND_SYSTEM.md")]);
});

test("no file anywhere means nothing is appended", async (t) => {
  const { cwd, agentDir } = await fixture(t);
  assert.deepEqual(appendSystemPromptSources(cwd, agentDir, true), []);
  assert.deepEqual(appendSystemPromptSources(cwd, agentDir, false), []);
});

test("no cwd reads the global file only", async (t) => {
  const { agentDir } = await fixture(t);
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "global");
  assert.deepEqual(appendSystemPromptSources("", agentDir, true), [join(agentDir, "APPEND_SYSTEM.md")]);
});
