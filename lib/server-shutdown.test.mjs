import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// The module under test has to run in a process of its own: a shutdown signal
// ends in `process.exit()`, which no in-process test survives. The `.ts` is
// stripped through jiti, the same transform the suite's own loader applies, so
// the child runs the real source and not a copy of it.
const jiti = createJiti(import.meta.url);
const source = await readFile(new URL("./server-shutdown.ts", import.meta.url), "utf8");
const stripped = jiti.transform({ source, filename: "server-shutdown.ts", ts: true });

const directory = await mkdtemp(join(tmpdir(), "pi-web-server-shutdown-"));
await writeFile(join(directory, "server-shutdown.cjs"), stripped, "utf8");

// A listening server is part of every case: it is the handle that keeps the
// event loop alive, so it is what a shutdown has to be able to end anyway.
const CHILD = `
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const { onServerShutdown } = require("./server-shutdown.cjs");

const [marker, mode, signal] = process.argv.slice(2);
createServer((request, response) => response.end("ok")).listen(0, "127.0.0.1");

if (mode === "hang") onServerShutdown(() => new Promise(() => {}));
else if (mode === "slow")
  onServerShutdown(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(marker, "ran");
  });
else if (mode === "twice") {
  let runs = 0;
  onServerShutdown(() => {
    runs += 1;
    writeFileSync(marker, String(runs));
  });
} else onServerShutdown(() => writeFileSync(marker, "ran"));

// After the server is listening, so the handle the shutdown has to survive is
// already there.
setTimeout(() => {
  process.kill(process.pid, signal);
  if (mode === "twice") process.kill(process.pid, signal);
}, 50);
`;

await writeFile(join(directory, "child.cjs"), CHILD, "utf8");

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Runs the child and resolves with its exit status once it is gone. */
function runChild(marker, mode, signal) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(directory, "child.cjs"), marker, mode, signal], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const bail = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the child never exited (stderr: ${stderr})`));
    }, 11_000);
    child.on("error", reject);
    child.on("exit", (code, exitSignal) => {
      clearTimeout(bail);
      resolve({ code, exitSignal, stderr, elapsed: Date.now() - started });
    });
  });
}

async function markerText(marker) {
  try {
    return await readFile(marker, "utf8");
  } catch {
    return null;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} runs the cleanups and exits`, async () => {
    const marker = join(directory, `marker-${signal}`);
    const result = await runChild(marker, "plain", signal);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.equal(result.exitSignal, null);
    assert.equal(await markerText(marker), "ran");
    assert.ok(result.elapsed < 3_000, `took ${result.elapsed}ms to stop`);
  });
}

test("the exit waits for a cleanup that is still working", async () => {
  const marker = join(directory, "marker-slow");
  const result = await runChild(marker, "slow", "SIGINT");

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(await markerText(marker), "ran");
  assert.ok(result.elapsed >= 200, `exited after ${result.elapsed}ms, before the cleanup finished`);
});

test("a second signal does not run the cleanups again", async () => {
  const marker = join(directory, "marker-twice");
  const result = await runChild(marker, "twice", "SIGINT");

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(await markerText(marker), "1");
});

test("a cleanup that never settles does not hold the process open", { timeout: 15_000 }, async () => {
  const marker = join(directory, "marker-hang");
  const result = await runChild(marker, "hang", "SIGINT");

  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.equal(await markerText(marker), null);
  assert.ok(result.elapsed >= 4_000, `exited after ${result.elapsed}ms, before the deadline`);
  assert.match(result.stderr, /still running after 5000ms, exiting/);
});
