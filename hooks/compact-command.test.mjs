import assert from "node:assert/strict";
import test from "node:test";
import { json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// `/compact` must not hold the composer hostage. runBuiltinCommand keeps the
// composer's <fieldset> disabled until the builtin command resolves, and a
// manual compaction is a blocking POST for the whole compaction, so awaiting it
// in the command handler left the input box dead until a remount. The command
// completes at once and runs the compaction detached, which reports itself:
// Compacting status, Stop compaction, result banner, error.

/** The compact POST blocks for the whole compaction, as the real one does. */
function compaction() {
  const gate = Promise.withResolvers();
  return {
    gate,
    handle: (entry) => (entry.body?.type === "compact" ? gate.promise : undefined),
  };
}

/** The composer's handle, with every method it may reach for. */
const composer = (restored) => ({ current: new Proxy({ prependText: (text) => restored.push(text) }, {
  get: (target, key) => target[key] ?? (() => {}),
}) });

const compactRequests = (requests) => requests.filter((entry) => entry.body?.type === "compact").map((entry) => entry.body);

test("/compact completes at once and runs the compaction detached", async () => {
  const { gate, handle } = compaction();
  await withAgentSession({ handle }, async (env) => {
    // The compact POST never resolves within this await: the command must still return.
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/compact"), { handled: true, action: "compact" });
    await env.settle();
    // No completion notice: the compaction's own UI is the answer.
    assert.deepEqual(env.hook.result.notices, []);
    // The detached compaction started and holds the Compacting state meanwhile.
    assert.equal(env.hook.result.isCompacting, true);
    assert.equal(env.hook.result.compactResult, null);
    assert.deepEqual(compactRequests(env.requests).map(({ type }) => type), ["compact"]);

    gate.resolve(json({ success: true, data: { tokensBefore: 10, estimatedTokensAfter: 5 } }));
    await env.settle();
    assert.equal(env.hook.result.isCompacting, false);
    assert.deepEqual(env.hook.result.compactResult, { reason: "manual", tokensBefore: 10, estimatedTokensAfter: 5 });
    assert.equal(env.hook.result.loading, false, "refreshing the compacted history must not unmount the focused composer with a loading screen");
  });
});

test("/compact passes its instructions to the detached compaction", async () => {
  const { gate, handle } = compaction();
  await withAgentSession({ handle }, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/compact keep the tests"), { handled: true, action: "compact" });
    assert.equal(compactRequests(env.requests)[0].customInstructions, "keep the tests");
    gate.resolve(json({ success: true, data: {} }));
    await env.settle();
  });
});

test("/compact gives its instructions back when the compaction fails", async () => {
  const { gate, handle } = compaction();
  const restored = [];
  await withAgentSession({ handle, props: { chatInputRef: composer(restored) } }, async (env) => {
    await env.hook.result.handleBuiltinSlashCommand("/compact keep the tests");
    gate.resolve(json({ error: "Nothing to compact (session too small)" }, 500));
    await env.settle();
    assert.equal(env.hook.result.compactError, "Nothing to compact (session too small)");
    assert.deepEqual(restored, ["/compact keep the tests"]);
  });
});
