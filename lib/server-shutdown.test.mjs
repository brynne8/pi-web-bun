import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import vm from "node:vm";

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
  // Windows process.kill terminates the child instead of delivering these
  // events. Dispatch them directly there; Unix still exercises OS delivery.
  const sendSignal = () => process.platform === "win32"
    ? process.emit(signal)
    : process.kill(process.pid, signal);
  sendSignal();
  if (mode === "twice") sendSignal();
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

function bundledCopies() {
  const listeners = new Map();
  const timers = [];
  const events = [];
  const context = vm.createContext({
    console: { log() {}, warn() {} },
    process: {
      on(signal, callback) {
        const handlers = listeners.get(signal) ?? [];
        handlers.push(callback);
        listeners.set(signal, handlers);
      },
      exit(code) { events.push({ exit: code }); },
    },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  });
  const load = () => vm.runInContext(`(function () { const exports = {};\n${stripped}\nreturn exports; })()`, context);
  return { first: load(), second: load(), listeners, timers, events };
}

const turn = () => new Promise(setImmediate);

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`independent bundles share ${signal} cleanup and outcome state`, async () => {
    const { first, second, listeners, timers, events } = bundledCopies();
    const signals = [];
    const release = [];
    for (const bundle of [first, second]) {
      bundle.onServerShutdown(async (received) => {
        signals.push(received);
        await new Promise((resolve) => release.push(resolve));
      });
    }
    first.subscribeShutdownOutcome((outcome) => events.push({ ...outcome }));
    second.subscribeShutdownOutcome(() => { throw new Error("observer failure"); });
    second.subscribeShutdownOutcome(async () => { throw new Error("async observer failure"); });
    second.subscribeShutdownOutcome(() => new Promise(() => {}));
    const unsubscribe = first.subscribeShutdownOutcome(() => assert.fail("unsubscribed observer"));
    unsubscribe();
    assert.equal(listeners.get("SIGINT").length, 1);
    assert.equal(listeners.get("SIGTERM").length, 1);
    listeners.get(signal)[0]();
    listeners.get("SIGINT")[0]();
    listeners.get("SIGTERM")[0]();
    await turn();
    assert.deepEqual(signals, [signal, signal]);
    assert.deepEqual(events, [{ signal, phase: "started", rejectedCleanups: 0, graceful: false }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 5000);
    assert.equal(timers[0].unrefed, true);
    release[0]();
    await turn();
    assert.equal(events.length, 1, "the other bundle's cleanup still holds exit");
    release[1]();
    await turn();
    assert.deepEqual(events.slice(1), [
      { signal, phase: "completed", rejectedCleanups: 0, graceful: true },
      { exit: 0 },
    ]);
    assert.equal(timers[0].cleared, true);
  });
}

for (const phase of ["completed", "deadline"]) {
  test(`${phase} reports rejected cleanups before exit across bundles`, async () => {
    const { first, second, listeners, timers, events } = bundledCopies();
    let release;
    first.onServerShutdown(() => { throw new Error("cleanup failed"); });
    second.onServerShutdown(() => new Promise((resolve) => { release = resolve; }));
    second.subscribeShutdownOutcome((outcome) => events.push({ ...outcome }));
    listeners.get("SIGTERM")[0]();
    await turn();
    if (phase === "deadline") timers[0].callback();
    else release();
    await turn();
    assert.deepEqual(events, [
      { signal: "SIGTERM", phase: "started", rejectedCleanups: 0, graceful: false },
      { signal: "SIGTERM", phase, rejectedCleanups: 1, graceful: false },
      { exit: 0 },
    ]);
    release();
    timers[0].callback();
    await turn();
    assert.equal(events.length, 3, "late completion or deadline cannot exit twice");
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
