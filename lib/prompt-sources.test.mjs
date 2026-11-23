import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPromptTextSources, refreshLoaderPromptText } from "./prompt-sources.ts";

/** A loader as this module reads one: the SDK's data fields, public at runtime. */
function makeLoader(dir, overrides = {}) {
  return {
    cwd: dir,
    agentDir: dir,
    noContextFiles: false,
    settingsManager: { isProjectTrusted: () => true },
    appendSystemPrompt: ["stale append"],
    agentsFiles: [{ path: join(dir, "AGENTS.md"), content: "stale context" }],
    ...overrides,
  };
}

async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return dir;
}

test("the project APPEND_SYSTEM.md answers while its folder is trusted, else the global one", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-append-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "APPEND_SYSTEM.md"), "project rules");
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "global rules");

  const trusted = readPromptTextSources(makeLoader(dir));
  assert.deepEqual(trusted.appendSystemPrompt, ["project rules"]);

  const untrusted = readPromptTextSources(makeLoader(dir, {
    settingsManager: { isProjectTrusted: () => false },
  }));
  assert.deepEqual(untrusted.appendSystemPrompt, ["global rules"]);
});

test("no APPEND_SYSTEM.md anywhere reads as no append text", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-none-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(readPromptTextSources(makeLoader(dir)).appendSystemPrompt, []);
});

test("the AGENTS.md files read in the SDK's order, the global one first", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-context-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "global agents");
  await writeFile(join(project, "AGENTS.md"), "project agents");

  assert.deepEqual(readPromptTextSources(makeLoader(project, { agentDir: dir })).contextFiles, [
    { path: join(dir, "AGENTS.md"), content: "global agents" },
    { path: join(project, "AGENTS.md"), content: "project agents" },
  ]);
});

test("a byte order mark is taken off the append text, as the loader's own read does", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-bom-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "\uFEFFno bom");
  assert.deepEqual(readPromptTextSources(makeLoader(dir)).appendSystemPrompt, ["no bom"]);
});

test("the refresh writes both prompt texts into the loader", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-write-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "new rules");
  await writeFile(join(dir, "AGENTS.md"), "new agents");
  const loader = makeLoader(dir);

  refreshLoaderPromptText(loader);

  assert.deepEqual(loader.appendSystemPrompt, ["new rules"]);
  assert.deepEqual(loader.agentsFiles, [{ path: join(dir, "AGENTS.md"), content: "new agents" }]);
});

test("a loader built with its own prompt text or a narrowed file list keeps it", async (t) => {
  const dir = await makeDir("pi-web-prompt-sources-guard-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "APPEND_SYSTEM.md"), "new rules");
  await writeFile(join(dir, "AGENTS.md"), "new agents");

  const withSources = makeLoader(dir, { appendSystemPromptSource: ["given"] });
  refreshLoaderPromptText(withSources);
  assert.deepEqual(withSources.appendSystemPrompt, ["stale append"]);

  const narrowed = makeLoader(dir, { agentsFilesOverride: () => ({}) });
  refreshLoaderPromptText(narrowed);
  assert.deepEqual(narrowed.agentsFiles, [{ path: join(dir, "AGENTS.md"), content: "stale context" }]);

  const withoutContext = makeLoader(dir, { noContextFiles: true });
  refreshLoaderPromptText(withoutContext);
  assert.deepEqual(withoutContext.agentsFiles, [{ path: join(dir, "AGENTS.md"), content: "stale context" }]);
  assert.deepEqual(readPromptTextSources(withoutContext).contextFiles, []);
});
