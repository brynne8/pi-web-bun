import assert from "node:assert/strict";
import test from "node:test";
import { withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// A session's wrapper tells its startup issues to every stream it opens, under the same
// ids (lib/rpc-manager.ts); the page shows each once, so a reconnect's replay adds nothing.

test("a startup notice a stream replays shows once on the page", async () => {
  await withAgentSession({}, async (env) => {
    await env.connect();
    const notice = { type: "extension_ui_request", id: "startup-1", method: "notify", notifyType: "error", message: "Failed to load extension: boom" };
    await env.emit(notice);
    // The stream reconnected, or the page came back to the session.
    await env.emit({ ...notice });
    await env.emit({ ...notice, id: "other" });
    assert.deepEqual(env.hook.result.notices.map((item) => item.id), ["startup-1", "other"]);
  });
});

test("an extension error names its extension as pi's TUI does", async () => {
  await withAgentSession({}, async (env) => {
    await env.connect();
    await env.emit({ type: "extension_error", extensionPath: "/ext/a.js", event: "turn_start", error: "boom" });
    await env.emit({ type: "extension_error", event: "turn_start" });
    assert.deepEqual(env.hook.result.notices.map((item) => item.message), ['Extension "/ext/a.js" error: boom', "Extension command failed"]);
  });
});
