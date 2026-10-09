// Runs a slice of TypeScript source in a `vm` sandbox and returns its completion
// value, for the tests that lift a callback out of a `.tsx` file and execute it.
//
// The suite already loads `.ts` through jiti, so its transpiler does the stripping:
// one code path on both runtimes, applying the same transform the real modules get.
// (Node's `stripTypeScriptTypes` is not exported by Bun, and Bun's own transpiler
// drops a top-level function expression as dead code — right for a module, fatal for
// a completion value.)
import { createJiti } from "jiti";
import vm from "node:vm";

const jiti = createJiti(import.meta.url);

export function runStripped(code, context) {
  const js = jiti.transform({ source: code, filename: "snippet.tsx", ts: true, jsx: true });
  return vm.runInContext(js, context);
}
