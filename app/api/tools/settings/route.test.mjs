import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "pi-web-tool-settings-route-")));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir, { recursive: true });
await mkdir(path.join(cwd, ".pi"), { recursive: true });
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");
const { GET, PUT } = await jiti.import("./route.ts");
allowFileRoot(cwd);

const settingsPath = path.join(agentDir, "settings.json");
const projectSettingsPath = path.join(cwd, ".pi", "settings.json");
const isWindows = process.platform === "win32";
const URL_BASE = "http://localhost/api/tools/settings";

/** `?cwd=` for the project the page describes; without one, the global settings alone. */
const forCwd = () => `?cwd=${encodeURIComponent(cwd)}`;

async function get(query = "") {
  const response = await GET(new Request(`${URL_BASE}${query}`, { headers: { host: "localhost" } }));
  return { status: response.status, body: await response.json() };
}

function put(body, query = "", headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request(`${URL_BASE}${query}`, {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/**
 * The self-test runs once per process and remembers its result on this symbol,
 * and Bun runs every file of the suite in one process — so a session an earlier
 * file started may already have settled it. Node's runner gives each file a
 * process of its own, where the symbol is always empty.
 */
async function withoutSandboxResult(t) {
  const key = Symbol.for("pi-web.codemodeSandbox");
  const previous = globalThis[key];
  delete globalThis[key];
  t.after(() => {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  });
}

test("reports the Code mode settings, with nothing configured read as Always on, on every platform", async (t) => {
  await withoutSandboxResult(t);
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const initial = await get();
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, {
    isWindows,
    powerShellEnabled: false,
    bgTasksEnabled: false,
    codemode: {
      sandbox: { state: "not-checked" },
      builtinDisabled: false,
      // Nothing configured means sessions start with Code mode on; it is the
      // application's default, not a setting every install has to write.
      preference: "always",
      mode: { settingsPath, value: "on" },
      inlineBudget: { settingsPath, default: 3000, max: 1_000_000 },
    },
  });
});

test("saves the Code mode choice, and Automatic is written as the -codemode modifier", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const automatic = await put({ codemode: "automatic" });
  assert.equal(automatic.status, 200);
  assert.equal((await automatic.json()).codemode.preference, "automatic");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", defaultTools: ["-codemode"] });

  // Always on is written as +codemode rather than by removing the key, so it stays
  // the choice if a list is edited by hand later.
  const always = await put({ codemode: "always" });
  assert.equal((await always.json()).codemode.preference, "always");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", defaultTools: ["+codemode"] });
});

test("saves the Code mode inline budget, and null gives sessions pi's default again", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m", codemode: { mode: "on" } }));
  const saved = await put({ codemodeInlineBudget: 1000 });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).codemode.inlineBudget, { settingsPath, value: 1000, default: 3000, max: 1_000_000 });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", codemode: { mode: "on", inlineBudget: 1000 } });

  const zero = await put({ codemodeInlineBudget: 0 });
  assert.equal((await zero.json()).codemode.inlineBudget.value, 0);

  const reset = await put({ codemodeInlineBudget: null });
  assert.deepEqual((await reset.json()).codemode.inlineBudget, { settingsPath, default: 3000, max: 1_000_000 });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", codemode: { mode: "on" } });

  // A codemode that is not an object is refused, not replaced.
  await writeFile(settingsPath, JSON.stringify({ codemode: "on" }));
  const refused = await put({ codemodeInlineBudget: 1000 });
  assert.equal(refused.status, 500);
  assert.match((await refused.json()).error, /codemode must be an object/);
  assert.equal(await readFile(settingsPath, "utf8"), JSON.stringify({ codemode: "on" }));
});

test("saves the Code mode mode, and \"on\" gives sessions pi's default again", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m", codemode: { inlineBudget: 1000 } }));
  const only = await put({ codemodeMode: "only" });
  assert.equal(only.status, 200);
  assert.deepEqual((await only.json()).codemode.mode, { settingsPath, value: "only" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", codemode: { inlineBudget: 1000, mode: "only" } });

  const on = await put({ codemodeMode: "on" });
  assert.deepEqual((await on.json()).codemode.mode, { settingsPath, value: "on" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", codemode: { inlineBudget: 1000 } });

  // A value that is neither mode is reported as pi reads it.
  await writeFile(settingsPath, JSON.stringify({ codemode: { mode: "never" } }));
  assert.deepEqual((await get()).body.codemode.mode, { settingsPath, value: "on", invalid: '"never"' });

  // A codemode that is not an object is refused, not replaced.
  await writeFile(settingsPath, JSON.stringify({ codemode: "only" }));
  const refused = await put({ codemodeMode: "only" });
  assert.equal(refused.status, 500);
  assert.match((await refused.json()).error, /codemode must be an object/);
  assert.equal(await readFile(settingsPath, "utf8"), JSON.stringify({ codemode: "only" }));
});

test("turns the background-bash switch on and off", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const enabled = await put({ bgTasksEnabled: true });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).bgTasksEnabled, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", bgTasksEnabled: true });

  // Absent reads as disabled again, so the key is removed rather than set false.
  const disabled = await put({ bgTasksEnabled: false });
  assert.equal((await disabled.json()).bgTasksEnabled, false);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });

  const refused = await put({ bgTasksEnabled: "yes" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).reason, "invalid-request");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });

  // The same file is what a new session reads at setup, so the switch and the
  // session cannot disagree about whether the bash tool carries run_in_background.
  const { isBgTasksEnabled } = await jiti.import("@/lib/bg-tasks-settings.ts");
  assert.equal(isBgTasksEnabled(settingsPath), false);
  await put({ bgTasksEnabled: true });
  assert.equal(isBgTasksEnabled(settingsPath), true);
});

test("a trusted project's own defaultTools is reported, naming its settings, and saves stay global", async (t) => {
  const store = new ProjectTrustStore(agentDir);
  t.after(async () => {
    store.set(cwd, null);
    await rm(projectSettingsPath, { force: true });
    await rm(settingsPath, { force: true });
  });
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  await writeFile(projectSettingsPath, JSON.stringify({ defaultTools: ["-codemode"] }));
  // Not trusted: no session reads the project's settings, so nothing is reported.
  assert.equal((await get(forCwd())).body.codemode.projectOverride, undefined);
  assert.equal((await get(forCwd())).body.codemode.preference, "always");

  store.set(cwd, true);
  assert.deepEqual((await get(forCwd())).body.codemode.projectOverride, {
    settingsPath: projectSettingsPath,
    preference: "automatic",
  });

  // A save is global whatever the page shows: the project keeps deciding for its own sessions.
  const saved = await put({ codemode: "automatic" }, forCwd());
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.codemode.preference, "automatic");
  assert.deepEqual(body.codemode.projectOverride, { settingsPath: projectSettingsPath, preference: "automatic" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", defaultTools: ["-codemode"] });
  assert.deepEqual(JSON.parse(await readFile(projectSettingsPath, "utf8")), { defaultTools: ["-codemode"] });
});

test("refuses a project folder it may not read, before any change", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  for (const [query, status, reason] of [
    ["?cwd=relative/path", 400, "cwd-invalid"],
    [`?cwd=${encodeURIComponent(path.dirname(root))}`, 403, "cwd-denied"],
  ]) {
    const read = await get(query);
    assert.deepEqual([read.status, read.body.reason], [status, reason], query);
    const write = await put({ codemode: "automatic" }, query);
    assert.deepEqual([write.status, (await write.json()).reason], [status, reason], query);
  }
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
});

test("rejects requests that do not name exactly one valid change, with a reason Settings › Tools translates", async () => {
  for (const body of [
    { codemode: "never" },
    { codemode: "always", enabled: true },
    { codemode: "always", codemodeInlineBudget: 1000 },
    { codemodeMode: "only", codemodeInlineBudget: 1000 },
    { codemodeMode: "off" },
    { codemodeMode: null },
    { codemodeMode: true },
    { codemodeInlineBudget: -1 },
    { codemodeInlineBudget: 1.5 },
    { codemodeInlineBudget: "3000" },
    { codemodeInlineBudget: 1_000_001 },
    { codemodeInlineBudget: true },
    { bgTasksEnabled: 1 },
    {},
    [],
    "{ not json",
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).reason, "invalid-request", JSON.stringify(body));
  }
  const plain = await put({ codemode: "always" }, "", { host: "localhost", "Content-Type": "text/plain" });
  assert.deepEqual([plain.status, await plain.json()], [415, { error: "Content-Type must be application/json", reason: "content-type" }]);
  const foreign = await put({ codemode: "always" }, "", { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" });
  assert.deepEqual([foreign.status, await foreign.json()], [403, { error: "Untrusted API request", reason: "request-denied" }]);
});

test("keeps the PowerShell switch Windows-only", { skip: isWindows }, async () => {
  const response = await put({ enabled: true });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).reason, "invalid-request");
});

test("refuses to write over a settings file it cannot parse, and leaves it where it is", async () => {
  await writeFile(settingsPath, "{ not json");
  const read = await get();
  assert.equal(read.status, 500);
  const readRefusal = read.body;
  assert.equal(readRefusal.reason, "internal");
  // The page shows the diagnostic of an internal failure, naming the file. The
  // parser's own wording is the engine's — V8 names the token it expected, JavaScriptCore
  // says `JSON Parse error` — so only the file named first and JSON blamed are pinned,
  // never one engine's phrasing (docs/agents/tests.md).
  assert.match(readRefusal.error, new RegExp(`${settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
  assert.match(readRefusal.error, /JSON/);

  // The file is pi's own, and pi reads it too: it stays where it is, so pi keeps
  // reporting the same failure and the user can repair it by hand.
  assert.deepEqual((await readdir(agentDir)).filter((name) => name.startsWith("settings.json.")), []);
  assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
  assert.equal((await get()).status, 500);

  // A write against a corrupt file is refused the same way.
  const write = await put({ codemode: "always" });
  assert.equal(write.status, 500);
  const writeRefusal = await write.json();
  assert.equal(writeRefusal.reason, "internal");
  assert.match(writeRefusal.error, /settings\.json: .*JSON/);
  assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
});
