import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SESSION, json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// The usage panel follows the run: a poll and a read after each complete reply, the newer
// answer winning, a failed one never discarding what a good one left, and a reply that
// belongs to a run, a session or a page that is gone changing nothing.

const usage = (tokens) => ({ percent: tokens / 100, contextWindow: 10_000, tokens });

/** Status reads answered one at a time, in the order the hook makes them. */
function statusGate() {
  const answers = [];
  const route = (entry) => {
    if (!entry.url.includes("?systemPrompt=0")) return undefined;
    const gate = Promise.withResolvers();
    answers.push(gate);
    return gate.promise;
  };
  route.answer = (index, state) => answers[index]?.resolve(json({ running: true, state }));
  route.fail = (index, response) => answers[index]?.resolve(response);
  route.reject = (index, error) => answers[index]?.reject(error);
  return route;
}

const reads = (env) => env.requests.filter((entry) => entry.url.includes("?systemPrompt=0"));

/**
 * A run in progress, its stream connected, and the test body driving it. Opening the
 * stream is itself the first status read, so the body answers gate 0 for that one and
 * gate 1 on for what it drives. The body runs inside withAgentSession: the hook it
 * drives stays mounted until the body is done, so its poll and its gates stay armed.
 */
function withRun(body, handle) {
  const status = handle ?? statusGate();
  return withAgentSession({ session: SESSION, handle: status }, async (env) => {
    await env.start();
    return body(env, status);
  });
}

test("a busy reconciliation refreshes context usage without settling the run", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await withRun(async (env, status) => {
      // The reconcile poll, on the hook's own clock.
      mock.timers.tick(15_000);
      await env.settle();
      assert.equal(reads(env).length, 2, "the poll read the state");
      status.answer(1, { contextUsage: usage(100), isStreaming: true, isPromptRunning: true });
      await env.settle();
      assert.deepEqual(env.hook.result.contextUsage, usage(100));
      assert.equal(env.hook.result.agentRunning, true, "the run is still running, so nothing settles");
    });
  } finally {
    mock.timers.reset();
  }
});

test("a usage read also carries the live active time, keyed to its session", async () => {
  await withRun(async (env, status) => {
    await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    status.answer(1, { contextUsage: usage(100), totalActiveMs: 112_900_000 });
    await env.settle();
    assert.equal(env.hook.result.sessionStats?.totalActiveMs, 112_900_000);

    // A read without the field leaves the last value alone.
    await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    status.answer(2, { contextUsage: usage(200) });
    await env.settle();
    assert.equal(env.hook.result.sessionStats?.totalActiveMs, 112_900_000);
  });
});

test("a newer assistant usage read wins over a delayed poll", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await withRun(async (env, status) => {
      mock.timers.tick(15_000);
      await env.settle();
      await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
      status.answer(2, { contextUsage: usage(200) });
      await env.settle();
      status.answer(1, { contextUsage: usage(100) });
      await env.settle();
      assert.deepEqual(env.hook.result.contextUsage, usage(200));
    });
  } finally {
    mock.timers.reset();
  }
});

test("a failed newer read does not discard an older poll's usage", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    await withRun(async (env, status) => {
      mock.timers.tick(15_000);
      await env.settle();
      await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
      status.fail(2, new Response("Unavailable", { status: 503 }));
      await env.settle();
      status.answer(1, { contextUsage: usage(100) });
      await env.settle();
      assert.deepEqual(env.hook.result.contextUsage, usage(100));
    });
  } finally {
    mock.timers.reset();
  }
});

test("usage replies from an old run are ignored", async () => {
  await withRun(async (env, status) => {
    const reading = env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    await reading;
    // The run ended and the page sent the next prompt: the read that answer belongs to
    // is a run that is over.
    await env.emit({ type: "agent_end" });
    await env.emit({ type: "agent_settled" });
    await env.hook.result.handleSend("the next prompt");
    await env.settle();
    status.answer(1, { contextUsage: usage(100) });
    await env.settle();
    assert.deepEqual(env.hook.result.contextUsage, null);
  });
});

test("a usage reply from another session is ignored", async () => {
  await withRun(async (env, status) => {
    const reading = env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    await reading;
    // The page moved to another session while the read was out.
    const other = await env.switchTo({ ...SESSION, id: "B", name: "B" });
    status.answer(1, { contextUsage: usage(100) });
    await other.settle();
    assert.deepEqual(other.hook.result.contextUsage, null);
  });
});

test("a usage reply for a page that is gone is ignored", async () => {
  await withRun(async (env, status) => {
    const reading = env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    await reading;
    // The tab was closed: the hook is unmounted, so nothing writes to it.
    env.unmount();
    status.answer(1, { contextUsage: usage(100) });
    await env.settle();
    assert.deepEqual(env.hook.result.contextUsage, null);
  });
});

test("failed reads preserve usage and a subsequent read can recover", async () => {
  await withRun(async (env, status) => {
    await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    status.fail(1, new Response("Unavailable", { status: 503 }));
    await env.settle();
    assert.deepEqual(env.hook.result.contextUsage, null);

    await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    status.reject(2, new TypeError("offline"));
    await env.settle();
    assert.deepEqual(env.hook.result.contextUsage, null);

    // A reply that carries no usage at all clears the panel, as a fresh session's does.
    await env.emit({ type: "message_end", message: { role: "assistant", content: [] } });
    status.answer(3, { contextUsage: null });
    await env.settle();
    assert.deepEqual(env.hook.result.contextUsage, null);
  });
});

test("only completed assistant messages trigger an immediate usage read", async () => {
  for (const role of ["assistant", "toolResult", "user", "system"]) {
    await withRun(async (env) => {
      const before = reads(env).length;
      await env.emit({ type: "message_end", message: { role, content: [] } });
      assert.equal(reads(env).length - before, role === "assistant" ? 1 : 0, role);
    });
  }
});

test("each event stream connection reads usage, since connecting resumes an idle-reaped session", async () => {
  for (const id of ["A", null]) {
    const status = statusGate();
    const readsAfter = await withAgentSession(
      { session: id ? { ...SESSION, id } : null, newSessionCwd: id ? null : "/project", handle: status },
      async (env) => {
        const before = reads(env).length;
        await env.connect();
        return reads(env).length - before;
      },
    );
    assert.equal(readsAfter, id ? 1 : 0, `${id}`);
  }
});
