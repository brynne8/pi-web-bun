import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { runStripped } from "./__fixtures__/strip-types.mjs";

const registrySource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const registryFunction = registrySource.match(/^function getRegistry\(\)[\s\S]*?^}/m)?.[0];
assert.ok(registryFunction, "getRegistry source must be found");
const shutdownSource = await readFile(new URL("./server-shutdown.ts", import.meta.url), "utf8");

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} waits for every registry session shutdown before exiting`, { timeout: 2_000 }, async () => {
    const listeners = new Map();
    const timers = [];
    const calls = [];
    const observedSignals = [];
    const releases = [];
    let finishExit;
    const exited = new Promise((resolve) => { finishExit = resolve; });
    const context = vm.createContext({
      exports: {},
      console,
      clearTimeout,
      setTimeout(callback, delay) {
        const timer = setTimeout(callback, delay);
        timers.push(timer);
        return timer;
      },
      process: {
        on: (event, callback) => listeners.set(event, callback),
        once: (event, callback) => listeners.set(event, callback),
        exit(code) {
          calls.push(`exit:${code}`);
          finishExit();
        },
      },
    });

    // Execute only the registry function, with the real shutdown coordinator;
    // its process and globals stay in this sandbox rather than the test runner.
    runStripped(shutdownSource, context);
    context.onServerShutdown = context.exports.onServerShutdown;
    const registry = runStripped(`${registryFunction}\ngetRegistry();`, context);
    context.onServerShutdown((receivedSignal) => { observedSignals.push(receivedSignal); });
    for (const id of ["failed", "slow"]) {
      const pending = new Promise((resolve) => releases.push(resolve));
      registry.set(id, {
        async shutdown() {
          calls.push(`start:${id}`);
          await pending;
          calls.push(`finished:${id}`);
          if (id === "failed") throw new Error("session cleanup failed");
        },
        destroy() { calls.push(`destroy:${id}`); },
      });
    }

    try {
      listeners.get(signal)();
      await new Promise(setImmediate);
      assert.deepEqual(observedSignals, [signal]);
      assert.deepEqual(calls, ["start:failed", "start:slow"], "exit must wait for pending session cleanup");

      releases[0]();
      await new Promise(setImmediate);
      assert.deepEqual(calls, ["start:failed", "start:slow", "finished:failed"], "one rejected shutdown must not bypass the remaining session");

      releases[1]();
      await exited;
      assert.deepEqual(calls, ["start:failed", "start:slow", "finished:failed", "finished:slow", "exit:0"]);
    } finally {
      releases.forEach((release) => release());
      timers.forEach(clearTimeout);
      await new Promise(setImmediate);
    }
  });
}
