import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { readGlobalSettings, updateGlobalSettings } = await createJiti(import.meta.url, { moduleCache: false })
  .import("./global-settings-file.ts");

async function settingsDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-global-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, settingsPath: join(dir, "settings.json") };
}

test("a settings file that does not parse is reported, naming the file, and left where it is", async (t) => {
  const { dir, settingsPath } = await settingsDir(t);
  await writeFile(settingsPath, "{ not json");

  // The file is pi's own, and pi reads it too: it stays where it is, so pi keeps
  // reporting the same failure and the user can repair it by hand.
  await assert.rejects(
    readGlobalSettings(settingsPath, (settings) => settings),
    (error) => {
      assert.match(error.message, new RegExp(`^${settingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
      // The parser's wording for a syntax error is the engine's — V8 names the token
      // it expected and gives a position, JavaScriptCore says `JSON Parse error` —
      // so what is pinned is the file named first and JSON blamed, never one
      // engine's phrasing (docs/agents/tests.md).
      assert.match(error.message, /JSON/);
      return true;
    },
  );

  assert.deepEqual(await readdir(dir), ["settings.json"]);
  assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
});

test("a write against a settings file that does not parse is refused, and its bytes are kept", async (t) => {
  const { dir, settingsPath } = await settingsDir(t);
  await writeFile(settingsPath, "{ not json");

  await assert.rejects(
    updateGlobalSettings(settingsPath, (settings) => { settings.defaultTools = ["read"]; }),
    (error) => {
      assert.ok(error instanceof SyntaxError, "the parser's own error type");
      assert.ok(error.message.startsWith(`${settingsPath}: `), error.message);
      return true;
    },
  );
  assert.deepEqual(await readdir(dir), ["settings.json"]);
  assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
});

test("a settings file that is not an object keeps its own message", async (t) => {
  const { dir, settingsPath } = await settingsDir(t);
  await writeFile(settingsPath, "[1, 2]");

  await assert.rejects(
    updateGlobalSettings(settingsPath, (settings) => { settings.defaultTools = ["read"]; }),
    /Invalid settings\.json: expected an object/,
  );
  assert.deepEqual(await readdir(dir), ["settings.json"]);
  assert.equal(await readFile(settingsPath, "utf8"), "[1, 2]");
});

test("a valid settings file is read and written as it is", async (t) => {
  const { dir, settingsPath } = await settingsDir(t);
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));

  assert.deepEqual(await readGlobalSettings(settingsPath, (settings) => settings), { defaultModel: "m" });
  await updateGlobalSettings(settingsPath, (settings) => { settings.bgTasksEnabled = true; });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", bgTasksEnabled: true });
  assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("a missing settings file reads as empty and is not created", async (t) => {
  const { dir, settingsPath } = await settingsDir(t);

  assert.deepEqual(await readGlobalSettings(settingsPath, (settings) => settings), {});
  assert.deepEqual(await readdir(dir), []);
});
