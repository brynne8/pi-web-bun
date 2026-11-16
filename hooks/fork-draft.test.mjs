import assert from "node:assert/strict";
import test from "node:test";
import { getDraft, json, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// A message's "New session" copies the branch up to that message, and the new session's
// composer starts with it, as pi's /fork leaves it in the editor. handleFork writes that
// draft under the new session's id before the switch, so the composer that mounts for it
// finds the draft; a fork an extension cancelled, or one that failed, writes none.

const DRAFT = { value: "Try it again", images: [{ data: "aW1n", mimeType: "image/png" }] };
const forkReply = (data) => (entry) => (entry.body?.type === "fork" ? json({ success: true, data }) : undefined);

test("a message's fork writes the message as the new session's draft before switching to it", async () => {
  const switched = [];
  await withAgentSession({
    draftKeys: ["A", "s1", "new:draft", "copy"],
    props: { onSessionForked: (id) => switched.push([id, getDraft(id)]) },
    handle: forkReply({ newSessionId: "copy" }),
  }, async (env) => {
    await env.hook.result.handleFork("entry-1", DRAFT);
    assert.deepEqual(env.log.filter((entry) => entry === "fork"), ["fork"]);
    assert.deepEqual(env.requests.find((entry) => entry.body?.type === "fork")?.body, { type: "fork", entryId: "entry-1" });
    assert.deepEqual(switched, [["copy", DRAFT]], "the switch finds the draft already written");
  });
});

test("a cancelled fork writes no draft", async () => {
  const switched = [];
  await withAgentSession({
    draftKeys: ["A", "s1", "new:draft", "copy"],
    props: { onSessionForked: (id) => switched.push(id) },
    handle: forkReply({ cancelled: true }),
  }, async (env) => {
    await env.hook.result.handleFork("entry-1", DRAFT);
    assert.deepEqual(switched, []);
    assert.equal(getDraft("copy"), null);
  });
});

test("a failed fork writes no draft and reports the error", async () => {
  const switched = [];
  await withAgentSession({
    draftKeys: ["A", "s1", "new:draft", "copy"],
    props: { onSessionForked: (id) => switched.push(id) },
    handle: (entry) => (entry.body?.type === "fork" ? json({ error: "Entry not found" }, 500) : undefined),
  }, async (env) => {
    await env.hook.result.handleFork("entry-1", DRAFT);
    assert.deepEqual(switched, []);
    assert.equal(getDraft("copy"), null);
    await env.settle();
    assert.deepEqual(env.hook.result.notices.map(({ type, message }) => [type, message]), [["error", "Entry not found"]]);
  });
});
