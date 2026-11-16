import assert from "node:assert/strict";
import test from "node:test";
import { withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// The retry banner follows pi's retry events for one run and for a summarizer's call: it
// shows while a retry waits and goes once the retried work starts or its retries finish.

const banner = (env) => (env.hook.result.retryInfo ? { ...env.hook.result.retryInfo } : null);

test("the retry banner shows while a retry waits and goes once the retried run starts", async () => {
  await withAgentSession({}, async (env) => {
    await env.connect();
    await env.emit({ type: "agent_start" });
    await env.emit({ type: "agent_end", willRetry: true });
    await env.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
    assert.deepEqual(banner(env), { attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
    // pi emits the successful auto_retry_end only after the retry's first complete reply.
    await env.emit({ type: "agent_start" });
    assert.equal(banner(env), null);
    await env.emit({ type: "auto_retry_end", success: true, attempt: 1 });
    assert.equal(banner(env), null);
  });
});

test("a summarizer's retry wait shows in the banner until its next attempt starts or the retries finish", async () => {
  await withAgentSession({}, async (env) => {
    await env.connect();
    await env.emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "503 overloaded" });
    assert.deepEqual(banner(env), { attempt: 1, maxAttempts: 3, errorMessage: "503 overloaded" });
    await env.emit({ type: "summarization_retry_attempt_start", reason: "manual", source: "compaction" });
    assert.equal(banner(env), null);
    await env.emit({ type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "503 overloaded" });
    assert.equal(banner(env)?.attempt, 2);
    await env.emit({ type: "summarization_retry_finished" });
    assert.equal(banner(env), null);
  });
});

test("the compaction's end clears a summarizer's banner when the stream missed its retry finishing", async () => {
  await withAgentSession({}, async (env) => {
    await env.connect();
    await env.emit({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "503 overloaded" });
    // The stream was down for summarization_retry_attempt_start and _finished.
    await env.emit({ type: "compaction_end", reason: "manual", result: { summary: "the summary" } });
    assert.equal(banner(env), null);
  });
});
