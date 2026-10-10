import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("bounds thinking previews to the first nonblank line without splitting Unicode characters", async () => {
  const { getThinkingPreview } = await loadSubject();
  assert.equal(getThinkingPreview(" \r\n **First line** \r\nSecond line"), "**First line**");
  assert.equal(getThinkingPreview("First\rSecond"), "First");
  assert.equal(getThinkingPreview(" \n\t"), "");
  assert.equal(getThinkingPreview("\u{1F4A1}".repeat(300)), "\u{1F4A1}".repeat(240));
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("treats compaction summaries as turn anchors", async () => {
  const { isMessageGroupAnchor } = await loadSubject();

  assert.equal(isMessageGroupAnchor({ role: "user", content: "prompt" }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor(assistant([])), false);
});

test("treats a background subagent completion as a turn anchor", async () => {
  const { isMessageGroupAnchor } = await loadSubject();

  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "pi-web:subagent-notification",
    content: "Subagent child completed.\n\nParser found",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "extension_debug",
    content: "hidden extension payload",
    display: false,
  }), false);
});

test("treats @tintinweb/pi-subagents' completion notification as a turn anchor (#1075)", async () => {
  const { isMessageGroupAnchor } = await loadSubject();
  // Sent as a follow-up that triggers a turn; without the anchor that turn's
  // reply became the final answer and folded the earlier one into Process details.
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "subagent-notification",
    content: "Background agent completed: Investigate",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "workflow-result",
    content: "Workflow finished",
    display: true,
  }), false);
});

test("hides custom messages without display, as pi's TUI does", async () => {
  const { isHiddenCustomMessage, isMessageGroupAnchor } = await loadSubject();
  const custom = (customType, display) => ({ role: "custom", customType, content: "payload", display });

  assert.equal(isHiddenCustomMessage(custom("firstpick:session-summary-rpc", false)), true);
  assert.equal(isHiddenCustomMessage(custom("legacy", undefined)), true);
  assert.equal(isHiddenCustomMessage(custom("extension", true)), false);
  assert.equal(isHiddenCustomMessage({ role: "user", content: "prompt" }), false);
  assert.equal(isHiddenCustomMessage(assistant([])), false);
  // Nothing renders for it, so it cannot start a turn either.
  assert.equal(isMessageGroupAnchor(custom("pi-web:subagent-notification", false)), false);
  assert.equal(isMessageGroupAnchor(custom("compaction", false)), false);
});

test("isAssistantTruncated is true only for a finished stopReason length", async () => {
  const { isAssistantTruncated } = await loadSubject();

  const truncated = {
    ...assistant([{ type: "thinking", thinking: " lengthy reasoning " }]),
    stopReason: "length",
  };
  assert.equal(isAssistantTruncated(truncated), true);
  // Still streaming: the final stopReason is not known yet.
  assert.equal(isAssistantTruncated(truncated, { isStreaming: true }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "stop" }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "error", errorMessage: "oops" }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]) }), false);
});
