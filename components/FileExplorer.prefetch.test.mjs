import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  tryNative: false,
});
const { prefetchFolders, PREFETCH_CONCURRENCY } = await jiti.import("./FileExplorer.tsx");

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A `load` that answers only when its own gate is run, so the order is the code's. */
function heldLoader() {
  const started = [];
  const gates = [];
  let live = 0;
  let peak = 0;
  const load = (path) => new Promise((resolve) => {
    started.push(path);
    live += 1;
    peak = Math.max(peak, live);
    gates.push(() => {
      live -= 1;
      resolve();
    });
  });
  return { started, gates, peak: () => peak, load };
}

test("a restored tree lists its open folders at once instead of one round trip per level", async () => {
  const paths = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `/repo/${name}`);
  const { started, gates, peak, load } = heldLoader();

  const done = prefetchFolders(paths, load);
  // The first wave is already away before any of them answers: no folder waits
  // for its parent's listing the way the level-by-level tree made it.
  assert.equal(started.length, PREFETCH_CONCURRENCY);
  assert.deepEqual(started, paths.slice(0, PREFETCH_CONCURRENCY));

  // One answer back and the next folder goes out at once, without a wave barrier.
  gates[0]();
  await tick();
  assert.equal(started.length, PREFETCH_CONCURRENCY + 1);

  // Release what is in flight until every folder has been started: a new gate
  // appears only after the previous answer settles, so this drains in waves.
  for (let guard = 0; guard < 50 && started.length < paths.length; guard += 1) {
    while (gates.length > 0) gates.shift()();
    await tick();
  }
  while (gates.length > 0) gates.shift()();
  await done;

  assert.equal(started.length, paths.length, "every folder is listed exactly once");
  assert.deepEqual([...started].sort(), [...paths].sort());
  assert.ok(peak() <= PREFETCH_CONCURRENCY, `at most ${PREFETCH_CONCURRENCY} at a time, saw ${peak()}`);
});

test("prefetching nothing resolves without a request", async () => {
  const { started, load } = heldLoader();
  await prefetchFolders([], load);
  assert.deepEqual(started, []);
});

test("a folder that answers with an error is still handed to the tree once", async () => {
  const attempts = [];
  const load = async (path) => {
    attempts.push(path);
    throw new Error("Not a directory");
  };
  await prefetchFolders(["/repo/gone", "/repo/there"], load);
  assert.deepEqual(attempts, ["/repo/gone", "/repo/there"]);
});
