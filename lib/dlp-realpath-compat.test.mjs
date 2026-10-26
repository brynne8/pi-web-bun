import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promises as fsPromises, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DLP_REALPATH_SHADOW_URL,
  describeRealpathCoverage,
  dlpRealpathHookSource,
  dlpRealpathShadowSource,
  installDlpRealpathCompat,
  registerFsPromisesShadow,
  reportRealpathCoverage,
} = await jiti.import("./dlp-realpath-compat.ts");

const self = fileURLToPath(import.meta.url);

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

// The hook and the shadow are source strings, so they are exercised as the
// loader would load them: written out and imported. Registering the hook here
// instead would install it for the whole process, which under Bun is the whole
// suite.
let scratch;
async function loadSource(name, source) {
  scratch ??= await mkdtemp(join(tmpdir(), "pi-web-dlp-"));
  const file = join(scratch, name);
  await writeFile(file, source, "utf8");
  return import(pathToFileURL(file).href);
}

const hookModule = () => loadSource("hook.mjs", dlpRealpathHookSource);
const shadowModule = () => loadSource("shadow.mjs", dlpRealpathShadowSource);

test.after(() => rm(scratch, { recursive: true, force: true }));

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

test("the hook sends a foreign node:fs/promises import to the shadow", async () => {
  const hook = await hookModule();
  const passed = async () => "passed-through";
  assert.deepEqual(await hook.resolve("node:fs/promises", { parentURL: pathToFileURL(self).href }, passed), {
    url: DLP_REALPATH_SHADOW_URL,
    shortCircuit: true,
  });
  // The shadow imports the real builtin itself, so its own request must not be
  // redirected: it would otherwise resolve to the shadow and cycle.
  assert.equal(await hook.resolve("node:fs/promises", { parentURL: DLP_REALPATH_SHADOW_URL }, passed), "passed-through");
  assert.equal(await hook.resolve("node:fs", { parentURL: pathToFileURL(self).href }, passed), "passed-through");
});

test("the hook answers the shadow's source and passes every other module on", async () => {
  const hook = await hookModule();
  const passed = async () => "passed-through";
  const loaded = await hook.load(DLP_REALPATH_SHADOW_URL, {}, passed);
  assert.equal(loaded.format, "module");
  assert.equal(loaded.source, dlpRealpathShadowSource);
  assert.equal(loaded.shortCircuit, true);
  assert.equal(await hook.load("node:fs", {}, passed), "passed-through");
});

test("the shadow re-exports the whole builtin and replaces only realpath", async () => {
  const shadow = await shadowModule();
  const real = await import("node:fs/promises");
  for (const name of ["readFile", "appendFile", "mkdir", "stat", "rm", "opendir"]) {
    assert.equal(shadow[name], real[name], `${name} must be the real export`);
  }
  assert.equal(shadow.default, real.default);
  assert.notEqual(shadow.realpath, real.realpath);
  assert.equal(shadow.realpath.name, "patchedRealpath");
});

test("the shadow's realpath answers a working query with the real path", async () => {
  const shadow = await shadowModule();
  assert.equal(await shadow.realpath(self), realpathSync(self));
});

test("the shadow's realpath rethrows anything but EISDIR", async () => {
  const shadow = await shadowModule();
  await assert.rejects(shadow.realpath(join(String(scratch), "not-here.md")), (error) => error.code === "ENOENT");
});

test("the shadow's realpath falls back to the sync query on EISDIR", async () => {
  const shadow = await shadowModule();
  const original = fsPromises.realpath;
  // Stand in for the driver: the handle-based query says a plain file is a directory.
  fsPromises.realpath = async () => {
    throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
  };
  try {
    // The sync query answers, which is the whole point of the fallback.
    assert.equal(await shadow.realpath(self), realpathSync(self));
  } finally {
    fsPromises.realpath = original;
  }
});

test("the hook registers once per process, and the module's own load did it", () => {
  // Bun's module.register runs no hooks, so the guard answers false there and
  // the object patch is all a Bun process gets; under Node this file's import of
  // the module already installed it, and the second call must not stack another.
  assert.equal(registerFsPromisesShadow(), false);
});

test("a named import of node:fs/promises reaches the fallback where the object patch cannot", async () => {
  // The two halves are runtime-specific by construction: Bun has no loader hook
  // that fires for a builtin, so the shadow is Node's and the object patch is
  // Bun's. What is asserted either way is that a consumer sees the fallback.
  assert.equal(await describeRealpathCoverage(), process.versions.bun ? "object" : "named");
});

test("the coverage report says what a consumer got, once", async () => {
  const lines = [];
  reportRealpathCoverage((line) => lines.push(line));
  reportRealpathCoverage((line) => lines.push(line));
  await new Promise(setImmediate);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /realpath EISDIR fallback/);
});
