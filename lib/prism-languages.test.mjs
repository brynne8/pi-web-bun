import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { refractor } from "refractor/core";

// Bun runs the whole suite in one process with one module registry, so a file that
// ran earlier (MermaidBlock's renders load the languages) leaves this module's state
// in place and the "nothing is loaded yet" start reads false. Drop the cached module
// so this file gets its own; under Node each file has its own process.
const nodeRequire = createRequire(import.meta.url);
delete nodeRequire.cache[realpathSync(fileURLToPath(new URL("./prism-languages.ts", import.meta.url)))];
const { loadPrismLanguages, prismLanguagesLoaded } = await createJiti(import.meta.url).import("./prism-languages.ts");

test("languages load into the core PrismLight renders with, aliases included", async () => {
  // PrismLight (react-syntax-highlighter/dist/esm/prism-light) highlights with refractor/core.
  assert.equal(prismLanguagesLoaded(), false);
  // There is no "nothing is registered yet" to assert here: refractor/core is one
  // instance for the whole process, and Bun runs the whole suite in one, so any
  // file that rendered highlighted code first (MermaidBlock's CodeBlock does) has
  // registered every language before this one starts. Under Node each file has a
  // process of its own and sees the cold registry. What holds either way follows.

  const first = loadPrismLanguages();
  assert.equal(loadPrismLanguages(), first, "one load for every caller");
  await first;

  assert.equal(prismLanguagesLoaded(), true);
  for (const name of ["typescript", "ts", "tsx", "javascript", "js", "bash", "sh", "shell", "python", "py", "json", "yaml", "yml", "css", "markup", "html", "diff", "rust", "go"]) {
    assert.equal(refractor.registered(name), true, `${name} is registered`);
  }
  const tree = refractor.highlight("const a: number = 1;", "ts");
  assert.ok(tree.children.some((node) => node.type === "element"), "ts is tokenized");
});
