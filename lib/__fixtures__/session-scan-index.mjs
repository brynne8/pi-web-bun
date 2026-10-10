// `lib/session-list-scanner.ts` keeps its incremental scan index on `globalThis`, so it
// outlives a module reload — the app has one agent dir per process and one index for it.
// Under a runner that keeps one process for the whole suite (Bun) that makes it one index
// for every file: the entries an earlier file left point at session files in *its* temp
// folder, so the next file's scan calls them stale and persists the index — to the agent
// dir that file is using, because the path comes from `PI_CODING_AGENT_DIR` at write time.
// That is how `app/api/project-trust/route.test.mjs` found a `pi-web-session-index.json`
// in the folder it asserts nothing was written to. Node's runner gives each file a
// process of its own, where the index starts empty.
//
// A file that lists sessions should reset it through the module's own helper before its
// tests and in `after()`, as `lib/session-list-scanner.test.mjs` does per test, and let a
// persist still queued land first: it resolves the destination when it runs, so it has to
// run while `PI_CODING_AGENT_DIR` still points at this file's agent dir.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resetSessionScanIndexForTests } = await jiti.import("../session-list-scanner.ts");

export async function resetSessionScanIndex() {
  await new Promise((resolve) => setImmediate(resolve));
  resetSessionScanIndexForTests();
}
