import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createOmitEmptyToolsExtension, omitEmptyTools, OMIT_EMPTY_TOOLS_EXTENSION_NAME } =
  await jiti.import("./omit-empty-tools.ts");

function loadHandler(extension) {
  const handlers = new Map();
  extension.factory({ on: (event, handler) => handlers.set(event, handler) });
  assert.deepEqual([...handlers.keys()], ["before_provider_request"]);
  return handlers.get("before_provider_request");
}

test("drops an empty tools array from a chat-completions request", async () => {
  const extension = createOmitEmptyToolsExtension();
  assert.equal(extension.name, OMIT_EMPTY_TOOLS_EXTENSION_NAME);
  assert.equal(extension.hidden, true);
  const handler = loadHandler(extension);
  const payload = {
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    tool_choice: "auto",
    stream: true,
  };

  const sent = await handler({ type: "before_provider_request", payload }, {});
  assert.ok(sent, "the request was passed through unchanged");
  assert.equal("tools" in sent, false, "an empty tools array reaches the upstream");
  assert.deepEqual(sent.messages, payload.messages);
  assert.equal(sent.model, "gpt-5");
  assert.equal(sent.tool_choice, "auto");
  assert.equal(sent.stream, true);
  // pi-ai keeps the object it built, so a later request starts from the array again.
  assert.deepEqual(payload.tools, []);
});

test("leaves every other request alone", async () => {
  const handler = loadHandler(createOmitEmptyToolsExtension());
  const requests = [
    // Tools the model can call: nothing to omit.
    { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "read" } }] },
    // No tools field at all, which is most requests.
    { messages: [{ role: "user", content: "hi" }] },
    // The responses api carries its transcript in `input`, not `messages`.
    { model: "gpt-5", input: [{ role: "user", content: "hi" }], tools: [] },
    // Not an object.
    "not a payload",
    null,
  ];
  for (const payload of requests) {
    assert.equal(await handler({ type: "before_provider_request", payload }, {}), undefined,
      JSON.stringify(payload));
  }
});

test("omitEmptyTools() reports no change rather than rebuilding the payload", () => {
  const withTools = { messages: [], tools: [{ type: "function" }] };
  assert.equal(omitEmptyTools(withTools), undefined);
  assert.equal(omitEmptyTools({ messages: [], tools: [] })?.messages.length, 0);
});

test("the empty array is still what pi-ai sends, and the hook still reaches the body", () => {
  // The greps are how this repo pins SDK internals (lib/retry-http2-stream-drops.test.mjs).
  const aiDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
  const agentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

  const completionsPath = join(aiDist, "api", "openai-completions.js");
  assert.ok(existsSync(completionsPath), `${completionsPath} is gone: re-derive where the body is built`);
  const completions = readFileSync(completionsPath, "utf8");
  // The workaround this extension exists to undo. Once pi-ai omits the field on its own,
  // delete lib/omit-empty-tools.ts and its registrations.
  assert.match(completions, /params\.tools = \[\];/);
  // The payload the handler returns is the one the HTTP call uses.
  assert.match(completions, /await options\?\.onPayload\?\.\(params, model\)/);

  const sdkPath = join(agentDist, "core", "sdk.js");
  assert.ok(existsSync(sdkPath), `${sdkPath} is gone: re-derive where the hook is wired`);
  assert.match(readFileSync(sdkPath, "utf8"), /onPayload: transformProviderPayload/);
});
