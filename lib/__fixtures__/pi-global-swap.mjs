import { after } from "node:test";

/**
 * Swaps of the server's `globalThis` registries, restored the way a Bun test file must.
 * Bun shares one `globalThis` with every later file, and a key swapped twice in one test
 * restores in hook order, so the first swap's fake registry is what survives the file. The
 * original is captured once, on the first swap, and every restore writes that back.
 * Call at the top level of the file: `after()` there is that file's hook.
 */
export function createPiGlobalSwaps() {
  const originals = new Map();

  const writeBack = (key) => {
    if (!originals.has(key)) return;
    const value = originals.get(key);
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  };

  after(() => {
    for (const key of originals.keys()) writeBack(key);
    originals.clear();
  });

  /** Set `globalThis[key]` for the duration of `t`, then back to what the file found. */
  return function swapGlobal(t, key, value) {
    if (!originals.has(key)) originals.set(key, globalThis[key]);
    globalThis[key] = value;
    t.after(() => writeBack(key));
  };
}
