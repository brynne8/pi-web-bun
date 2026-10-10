import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getTurnPart, recordsUsage } = await jiti.import("./turn-views.ts");

function assistant() {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    usage: { input: 1, output: 2 },
    content: [
      { type: "thinking", thinking: "Plan" },
      { type: "toolCall", toolCallId: "t1", toolName: "write", input: { path: "a.txt" } },
      { type: "text", text: "Working on it." },
      { type: "toolCall", toolCallId: "t2", toolName: "bash", input: {} },
      { type: "text", text: "Done." },
    ],
  };
}

test("a part carries the block range it was asked for", () => {
  const part = getTurnPart(new WeakMap(), assistant(), 3, 5);
  assert.deepEqual(part.content.map((block) => block.type), ["toolCall", "text"]);
  assert.equal(part.content[1].text, "Done.");
});

test("the same range of the same message is the same object every render (#1005)", () => {
  const message = assistant();
  const cache = new WeakMap();
  const first = getTurnPart(cache, message, 0, 2);
  assert.equal(getTurnPart(cache, message, 0, 2), first);
  assert.notEqual(getTurnPart(cache, message, 3, 5), first);
  assert.notEqual(first, message, "a part is a copy, so the stored message is never mutated");
});

test("only the part that ends the response carries usage and its notices", () => {
  const message = { ...assistant(), stopReason: "error", errorMessage: "Connection closed" };
  const earlier = getTurnPart(new WeakMap(), message, 0, 2);
  assert.equal(earlier.usage, undefined);
  assert.equal(earlier.stopReason, undefined);
  assert.equal(earlier.errorMessage, undefined);

  const last = getTurnPart(new WeakMap(), message, 3, 5);
  assert.deepEqual(last.usage, message.usage);
  assert.equal(last.stopReason, "error");
  assert.equal(last.errorMessage, "Connection closed");
});

test("usage counts for the turn's footer only when it records numbers", () => {
  const usage = (over) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, ...over });
  assert.equal(recordsUsage(usage({ input: 120, output: 30 })), true);
  // A request that was cut off still gets a usage object; every number is zero.
  assert.equal(recordsUsage(usage()), false);
  assert.equal(recordsUsage(usage({ output: 6 })), true);
  assert.equal(recordsUsage(usage({ cost: { total: 0.02 } })), true);
});
