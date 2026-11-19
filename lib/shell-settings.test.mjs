import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveShellPath, withShellDefault } = await jiti.import("./shell-settings.ts");

test("the shell commands run with is zsh on macOS and pi's own resolution elsewhere", () => {
  assert.equal(resolveShellPath("darwin", () => true), "/bin/zsh");
  // A zsh that is not there is left to pi, whose resolution refuses a missing shell.
  assert.equal(resolveShellPath("darwin", () => false), undefined);
  assert.equal(resolveShellPath("linux", () => true), undefined);
  assert.equal(resolveShellPath("win32", () => true), undefined);
});

test("a session's settings manager supplies that default where no layer set shellPath", async () => {
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  assert.equal(
    withShellDefault(SettingsManager.inMemory({ shellPath: "/bin/sh" })).getShellPath(),
    "/bin/sh",
    "a settings layer keeps the last word",
  );
  assert.equal(
    withShellDefault(SettingsManager.inMemory({})).getShellPath(),
    resolveShellPath(),
    "no layer set: the platform default, whatever this machine is",
  );
});
