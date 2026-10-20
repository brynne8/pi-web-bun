import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { installDlpRealpathCompat, describeRealpathBinding } = await jiti.import("./dlp-realpath-compat.ts");

/** An `fs.promises`-shaped stand-in whose `realpath` runs `behaviour`. */
function fakeFs(behaviour) {
  const calls = [];
  return {
    calls,
    realpath: async (path, ...rest) => {
      calls.push(["async", path, ...rest]);
      return behaviour(path, rest);
    },
  };
}

/** A `behaviour` that rejects with `code`, the way a failed realpath does. */
function failsWith(code) {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
}

test("a working realpath is passed through untouched", async () => {
  const fs = fakeFs((path) => `real:${path}`);
  installDlpRealpathCompat(fs, () => "sync");
  assert.equal(await fs.realpath("a.txt"), "real:a.txt");
  assert.deepEqual(fs.calls, [["async", "a.txt"]]);
});

test("EISDIR falls back to the path-based query", async () => {
  const fs = fakeFs(failsWith("EISDIR"));
  const syncCalls = [];
  installDlpRealpathCompat(fs, (path, options) => {
    syncCalls.push([path, options]);
    return "C:\\dir\\file.md";
  });
  assert.equal(await fs.realpath("file.md", { encoding: "buffer" }), "C:\\dir\\file.md");
  // The options travel to the sync query as the same second argument.
  assert.deepEqual(syncCalls, [["file.md", { encoding: "buffer" }]]);
});

test("a path the sync query cannot resolve either keeps its own name", async () => {
  const fs = fakeFs(failsWith("EISDIR"));
  installDlpRealpathCompat(fs, () => {
    throw new Error("nope");
  });
  assert.equal(await fs.realpath("C:\\dir\\file.md"), "C:\\dir\\file.md");
});

test("every other error is rethrown untouched", async () => {
  for (const code of ["ENOENT", "EPERM", "EINVAL"]) {
    const fs = fakeFs(failsWith(code));
    let syncCalled = false;
    installDlpRealpathCompat(fs, () => {
      syncCalled = true;
      return "unused";
    });
    await assert.rejects(fs.realpath("gone.md"), (error) => error.code === code);
    assert.equal(syncCalled, false, `${code} must not reach the fallback`);
  }
});

test("loading it twice cannot wrap realpath twice", () => {
  const fs = fakeFs(() => "ok");
  assert.equal(installDlpRealpathCompat(fs, () => "sync"), true);
  assert.equal(installDlpRealpathCompat(fs, () => "sync"), false);
});

test("the load-order report answers, whichever side of the load it ran on", async () => {
  // Whether the process was early enough depends on what the runner imported
  // before this module, and a named builtin import is a frozen snapshot under
  // Bun, so only the answer's shape is pinned here. On a real server the line it
  // logs at start-up is what a developer reads.
  assert.ok(["bound", "late"].includes(await describeRealpathBinding()));
});
