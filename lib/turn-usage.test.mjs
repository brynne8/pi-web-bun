import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getTurnUsage } = await jiti.import("./turn-usage.ts");

const user = () => ({ role: "user", content: "hi" });
const usage = (overrides = {}) => ({
  input: 100,
  output: 10,
  cacheRead: 1_000,
  cacheWrite: 20,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
  ...overrides,
});
const reply = (usageValue, stopReason = "toolUse") => ({ role: "assistant", content: [], model: "m", provider: "p", stopReason, usage: usageValue });
const result = (usageValue) => ({ role: "toolResult", toolCallId: "c", content: [], usage: usageValue });

test("a turn's numbers are every request it made, not the last", () => {
  // The tool loop: one request with a tool call, then the request that answers.
  // The footer used to keep only the answering response's usage.
  const messages = [user(), reply(usage()), result(undefined), reply(usage({ input: 200, output: 4, cacheRead: 300, cacheWrite: 5, cost: { ...usage().cost, total: 0.25 } }), "stop")];
  const total = getTurnUsage(messages, 0, messages.length);
  assert.equal(total.input, 300);
  assert.equal(total.output, 14);
  assert.equal(total.cacheRead, 1_300);
  assert.equal(total.cacheWrite, 25);
  assert.equal(total.cost.total, 0.35);
});

test("a single-request turn is exactly that response", () => {
  const one = usage({ input: 42, output: 7, cacheRead: 900, cacheWrite: 3, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } });
  const total = getTurnUsage([user(), reply(one, "stop")], 0, 2);
  assert.deepEqual(total, one);
});

test("the cache buckets stay apart from input, so a cache read never inflates it", () => {
  const total = getTurnUsage([user(), reply(usage({ input: 5, output: 1, cacheRead: 90_000, cacheWrite: 0 }), "stop")], 0, 2);
  assert.equal(total.input, 5);
  assert.equal(total.cacheRead, 90_000);
  assert.equal(total.cacheWrite, 0);
});

test("a tool result's nested usage is not one of the turn's requests", () => {
  const total = getTurnUsage([user(), reply(usage(), "stop"), result(usage({ input: 9_999 }))], 0, 3);
  assert.equal(total.input, 100);
});

test("only the messages before the next anchor belong to the turn", () => {
  const messages = [user(), reply(usage({ input: 1 }), "stop"), user(), reply(usage({ input: 50 }), "stop")];
  assert.equal(getTurnUsage(messages, 0, 2).input, 1);
  assert.equal(getTurnUsage(messages, 2, 4).input, 50);
});

test("a run that billed nothing has no numbers to show", () => {
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  assert.equal(getTurnUsage([user(), reply(zeros, "aborted")], 0, 2), undefined);
  assert.equal(getTurnUsage([user(), reply(undefined, "aborted")], 0, 2), undefined);
  // One billed request among zero ones is still the turn's total.
  assert.equal(getTurnUsage([user(), reply(zeros), reply(usage({ input: 8 }), "stop")], 0, 3).input, 8);
});
