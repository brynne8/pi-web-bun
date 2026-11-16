import assert from "node:assert/strict";
import test from "node:test";
import { SESSION, json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// `/clone` asks pi's `session_before_fork` handlers, as pi's /clone does. A handler's
// cancel (`byExtension`) says nothing more, as in pi; only the server's own refusal of
// an empty or unsaved session is reported.

const session = { ...SESSION, leafId: "leaf-1" };
const cloneReply = (data) => (entry) => (entry.body?.type === "clone" ? json({ success: true, data }) : undefined);
const cloneRequests = (requests) => requests.filter((entry) => entry.body?.type === "clone").map((entry) => entry.body);

test("a /clone a session_before_fork handler cancelled says nothing and opens no copy", async () => {
  const forked = [];
  await withAgentSession({
    session,
    props: { onSessionForked: (id) => forked.push(id) },
    handle: cloneReply({ cancelled: true, byExtension: true }),
  }, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/clone"), { handled: true });
    assert.deepEqual(cloneRequests(env.requests), [{ type: "clone", leafId: "leaf-1" }]);
    assert.deepEqual(env.hook.result.notices, []);
    assert.deepEqual(forked, []);
  });
});

test("/clone of an empty or unsaved session is still reported", async () => {
  const forked = [];
  await withAgentSession({
    session,
    props: { onSessionForked: (id) => forked.push(id) },
    handle: cloneReply({ cancelled: true }),
  }, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/clone"), { handled: true, error: "Cannot clone an empty or unsaved session" });
    await env.settle();
    assert.deepEqual(env.hook.result.notices.map(({ type, message }) => [type, message]), [["error", "Cannot clone an empty or unsaved session"]]);
    assert.deepEqual(forked, []);
  });
});

test("/clone opens the copy", async () => {
  const forked = [];
  await withAgentSession({
    session,
    props: { onSessionForked: (id) => forked.push(id) },
    handle: cloneReply({ cancelled: false, newSessionId: "session-2" }),
  }, async (env) => {
    assert.deepEqual(await env.hook.result.handleBuiltinSlashCommand("/clone"), { handled: true, message: "Cloned current session branch" });
    assert.deepEqual(forked, ["session-2"]);
  });
});
