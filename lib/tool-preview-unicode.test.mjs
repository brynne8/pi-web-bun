import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Through jiti: `lib/tool-fields.ts` imports its sibling by its extensionless name, which
// only a loader that fills the extension in resolves (docs/agents/tests.md).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, tryNative: false });
const { toolInputPreview } = await jiti.import("./tool-fields.ts");

test("collapsed tool previews never cut an emoji into an unpaired surrogate", () => {
  const text = "x".repeat(119) + "🔎tail";
  for (const input of [{ command: text }, { query: text }, { questions: [{ question: text }] }]) {
    const preview = toolInputPreview(input);
    assert.equal(preview, "x".repeat(119));
    assert.equal(preview.isWellFormed(), true);
  }
  assert.equal(toolInputPreview({ path: "x".repeat(118) + "🔎tail" }), "x".repeat(118) + "🔎");
});
