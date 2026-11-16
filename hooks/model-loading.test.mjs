import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { SESSION, json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// A models read that fails stays visible through bounded retries (2 s, 5 s, 10 s) and
// clears when one succeeds; a folder that no longer exists is reported as that.

const CATALOG = {
  models: { "custom:test": "Test", "custom:fast": "Fast" },
  modelList: [{ provider: "custom", id: "test", name: "Test" }, { provider: "custom", id: "fast", name: "Fast" }],
  defaultModel: { provider: "custom", modelId: "test" },
  thinkingLevelPins: { "custom/test": "high", "custom/fast": "low" },
};

/** The models route, answered by `reply(attempt)`; every other request takes the defaults. */
function modelsRoute(reply) {
  let attempts = 0;
  const route = (entry) => (entry.url.startsWith("/api/models") ? reply(++attempts) : undefined);
  route.attempts = () => attempts;
  return route;
}

/** With mock timers on, a retry runs only when the test moves the clock. */
async function pass(env, ms) {
  mock.timers.tick(ms);
  await env.settle();
}

test("model-load failures stay visible through bounded retries and clear on recovery", async () => {
  const failures = [
    [() => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    [() => json({ error: "Access denied" }, 403), "Access denied"],
    [() => new Response("Unavailable", { status: 503 }), "Failed to load models (HTTP 503)"],
    [() => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }), "Invalid JSON"],
  ];
  for (const [reply, expected] of failures) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const route = modelsRoute(() => reply());
      await withAgentSession({ handle: route }, async (env) => {
        assert.equal(route.attempts(), 1);
        await pass(env, 1_999);
        assert.equal(route.attempts(), 1, "the first retry waits 2 s");
        await pass(env, 1);
        assert.equal(route.attempts(), 2);
        await pass(env, 5_000);
        assert.equal(route.attempts(), 3);
        await pass(env, 10_000);
        assert.equal(route.attempts(), 4);
        await pass(env, 60_000);
        assert.equal(route.attempts(), 4, "the retries stop");
        assert.equal(env.hook.result.modelError, expected);
        assert.equal(env.hook.result.missingCwd, null);
      });
    } finally {
      mock.timers.reset();
    }
  }
});

test("a load recovered on its first retry clears the error and shows the catalog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const route = modelsRoute((attempt) => {
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return json(CATALOG);
    });
    await withAgentSession({ session: null, newSessionCwd: "/project", handle: route }, async (env) => {
      await pass(env, 2_000);
      assert.equal(route.attempts(), 2);
      assert.equal(env.hook.result.modelError, null);
      assert.deepEqual(env.hook.result.modelList.map(({ id }) => id), ["test", "fast"]);
      assert.deepEqual(env.hook.result.displayModel, { provider: "custom", modelId: "test" });
      assert.equal(env.hook.result.thinkingLevel, "high");
    });
  } finally {
    mock.timers.reset();
  }
});

test("a folder that no longer exists is reported as such, not as a model error (#1422)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const route = modelsRoute((attempt) => (attempt <= 2
      ? json({ error: "Directory does not exist: /old/app", reason: "cwd-missing", cwd: "/old/app" }, 400)
      : json({ models: {}, modelList: [] })));
    await withAgentSession({ session: null, newSessionCwd: "/project", handle: route }, async (env) => {
      await pass(env, 2_000);
      assert.equal(route.attempts(), 2);
      assert.equal(env.hook.result.missingCwd, "/old/app");
      assert.equal(env.hook.result.modelError, null);
      await pass(env, 5_000);
      assert.equal(route.attempts(), 3);
      assert.equal(env.hook.result.missingCwd, null, "the folder the next answer lists is back");
      assert.equal(env.hook.result.modelError, null);
    });
  } finally {
    mock.timers.reset();
  }
});

test("a models read from a removed worktree's main repo never clears a refused prompt's folder", async () => {
  await withAgentSession({
    session: SESSION,
    handle: (entry) => (entry.body?.type === "prompt"
      ? json({ error: "Directory does not exist: /old/app", reason: "cwd-missing", cwd: "/old/app", code: "prompt_rejected", accepted: false }, 500)
      : undefined),
  }, async (env) => {
    await env.connect();
    await env.hook.result.handleSend("hi");
    await env.settle();
    assert.equal(env.hook.result.missingCwd, "/old/app");
    // A models load that succeeds reads from the removed worktree's main repo.
    await env.rerender({ modelsRefreshKey: 1 });
    assert.equal(env.hook.result.missingCwd, "/old/app");
  });
});

test("cancelling model loads prevents state writes and further retries", async () => {
  for (const status of [200, 403]) {
    const answers = [Promise.withResolvers(), Promise.withResolvers()];
    const route = modelsRoute((attempt) => answers[attempt - 1].promise);
    await withAgentSession({ handle: route }, async (env) => {
      // A refresh aborts the load under way and starts its own.
      await env.rerender({ modelsRefreshKey: 1 });
      assert.equal(route.attempts(), 2);
      answers[0].resolve(status === 200 ? json(CATALOG) : json({ error: "Access denied" }, status));
      await env.settle();
      assert.deepEqual(env.hook.result.modelList, [], "an aborted load writes nothing");
      assert.equal(env.hook.result.modelError, null);
      answers[1].resolve(json({ models: {}, modelList: [] }));
      await env.settle();
    });
  }

  // The reply that arrives after the abort, from a body already being read.
  const answers = [Promise.withResolvers(), Promise.withResolvers()];
  const late = modelsRoute((attempt) => answers[attempt - 1].promise);
  await withAgentSession({ handle: late }, async (env) => {
    await env.rerender({ modelsRefreshKey: 1 });
    answers[0].resolve({ ok: true, json: async () => CATALOG });
    await env.settle();
    assert.deepEqual(env.hook.result.modelList, []);
    answers[1].resolve(json({ models: {}, modelList: [] }));
    await env.settle();
  });

  // A load cancelled while it waits to retry does not retry.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const retrying = modelsRoute(() => json({ error: "Unavailable" }, 503));
    await withAgentSession({ handle: retrying }, async (env) => {
      assert.equal(retrying.attempts(), 1);
      await env.rerender({ modelsRefreshKey: 1 });
      await pass(env, 2_000);
      await pass(env, 5_000);
      await pass(env, 10_000);
      await pass(env, 60_000);
      assert.equal(retrying.attempts(), 5, "only the second load's own four attempts ran");
    });
  } finally {
    mock.timers.reset();
  }
});

test("a picked model the folder offers keeps its pinned reasoning level; one it does not list goes back to automatic", async () => {
  const pick = (model) => ({ initialNewSessionChoices: { model, thinkingLevel: null } });

  // Carried over from the composer this one replaced, and offered here.
  await withAgentSession({ session: null, newSessionCwd: "/project", props: pick({ provider: "custom", modelId: "fast" }), handle: modelsRoute(() => json(CATALOG)) }, async (env) => {
    assert.deepEqual(env.hook.result.newSessionModel, { provider: "custom", modelId: "fast" });
    assert.equal(env.hook.result.thinkingLevel, "low");
  });

  // A model another project scoped in that this one does not list.
  await withAgentSession({ session: null, newSessionCwd: "/project", props: pick({ provider: "other", modelId: "gone" }), handle: modelsRoute(() => json(CATALOG)) }, async (env) => {
    assert.equal(env.hook.result.newSessionModel, null);
    assert.equal(env.hook.result.isAutoThinkingSelection, true);
    assert.equal(env.hook.result.thinkingLevel, "high");
  });

  // A failed load answers 200 with no models (withSafeModelLoadFailure): nothing to compare with, the pick stays.
  await withAgentSession({ session: null, newSessionCwd: "/project", props: pick({ provider: "custom", modelId: "fast" }), handle: modelsRoute(() => json({ models: {}, modelList: [], defaultModel: null, modelError: "Models could not be loaded" })) }, async (env) => {
    assert.deepEqual(env.hook.result.newSessionModel, { provider: "custom", modelId: "fast" });
  });

  // Once the session exists it keeps whatever it was started with.
  const catalogs = [CATALOG, { models: {}, modelList: [{ provider: "custom", id: "test", name: "Test" }], defaultModel: { provider: "custom", modelId: "test" } }];
  let load = 0;
  await withAgentSession({
    session: null,
    newSessionCwd: "/project",
    props: pick({ provider: "custom", modelId: "fast" }),
    handle: modelsRoute(() => json(catalogs[Math.min(load++, 1)])),
  }, async (env) => {
    const sending = env.hook.result.handleSend("start it");
    await env.settle();
    await env.connect();
    await sending;
    await env.rerender({ modelsRefreshKey: 1 });
    assert.equal(load, 2, "the reload answered a catalog without the pick");
    assert.deepEqual(env.hook.result.newSessionModel, { provider: "custom", modelId: "fast" });
  });
});
