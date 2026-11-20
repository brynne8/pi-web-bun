import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadSubject() {
  return jiti.import("./message-display.ts");
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
  // A model's terminal escapes, as pi's TUI leaves them to the terminal (#1753).
  assert.equal(getThinkingPreview("\x1b[2m \x1b[38;5;5mThinking:\x1b[39m \x1b[2mInteresting\nnext"), "Thinking: Interesting");
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

const user = (text = "prompt") => ({ role: "user", content: text });
const reply = (stopReason, text = "answer") => ({ ...assistant([{ type: "text", text }]), stopReason });
const toolResult = () => ({ role: "toolResult", toolCallId: "call", toolName: "bash", content: [] });
const ext = (customType, display) => ({ role: "custom", customType, content: "payload", display });
const anchorsOf = async (messages, options) => {
  const { getTurnAnchors } = await loadSubject();
  return getTurnAnchors(messages, options).flatMap((anchor, idx) => (anchor ? [idx] : []));
};

test("an extension message that opened a run after the answer starts a turn at its last shown message", async () => {
  // pi-background-bash: a shown completion (triggerTurn: false), then a hidden wake-up that triggers the run.
  assert.deepEqual(await anchorsOf([
    user(),
    reply("toolUse"),
    toolResult(),
    reply("stop"),
    ext("pi-background-bash:completion", true),
    ext("pi-background-bash:wakeup", false),
    reply("stop", "follow-up"),
  ]), [0, 4]);
  // Two shown messages: the last one opens the turn, the earlier one stays after the answer above.
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), ext("note", true), ext("note", true), ext("wake", false), reply("stop"),
  ]), [0, 3]);
  // A `!` command between the answer and the message does not hide the run's start.
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), { role: "bashExecution", command: "ls", output: "" }, ext("wake", true), reply("stop"),
  ]), [0, 3]);
  // A `!` command after the last shown message: the hidden wake-up below it opens the turn.
  // Anchored at the note, the command would sit between anchor and answer, where no card renders.
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), ext("note", true), { role: "bashExecution", command: "ls", output: "" }, ext("wake", false), reply("stop"),
  ]), [0, 4]);
  // An answer cut by Stop ended its run too.
  assert.deepEqual(await anchorsOf([user(), reply("aborted"), ext("timer", true), reply("stop")]), [0, 2]);
});

test("a run opened only by a hidden message starts its turn at that message", async () => {
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), ext("pi-background-bash:wakeup", false), reply("stop", "follow-up"),
  ]), [0, 2]);
  const { getTurnAnchors, hasTurnRef } = await loadSubject();
  const messages = [user(), reply("stop"), ext("wake", false), reply("stop")];
  const anchors = getTurnAnchors(messages);
  // It renders nothing, so the chat gives it no scroll ref.
  assert.deepEqual(messages.map((message, idx) => hasTurnRef(message, anchors[idx])), [true, true, false, true]);
});

test("extension messages inside a run, or that no reply followed, stay in their turn", async () => {
  // Delivered between a tool call and the next reply (a steer, a completion flushed mid-run).
  assert.deepEqual(await anchorsOf([
    user(), reply("toolUse"), toolResult(), ext("pi-background-bash:completion", true), reply("stop"),
  ]), [0]);
  // A reply cut at the output limit is continued in the same run (pi-error-retry's continue message).
  assert.deepEqual(await anchorsOf([user(), reply("length"), ext("pi-error-retry.continue", true), reply("stop")]), [0]);
  assert.deepEqual(await anchorsOf([user(), reply("error"), ext("retry", true), reply("stop")]), [0]);
  // Shown while idle, nothing answered it.
  assert.deepEqual(await anchorsOf([user(), reply("stop"), ext("timer", true)]), [0]);
  assert.deepEqual(await anchorsOf([user(), reply("stop"), ext("timer", true), user("next"), reply("stop")]), [0, 3]);
  // At the start of a page there is no answer above to tell.
  assert.deepEqual(await anchorsOf([ext("wake", true), reply("stop")]), []);
});

test("while a run goes, a trailing extension message opens the turn before its reply lands", async () => {
  const messages = [user(), reply("stop"), ext("pi-background-bash:completion", true), ext("pi-background-bash:wakeup", false)];
  assert.deepEqual(await anchorsOf(messages), [0]);
  assert.deepEqual(await anchorsOf(messages, { openTail: true }), [0, 2]);
});

test("a stretch holding a subagent completion or compaction keeps that anchor alone", async () => {
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), ext("note", true), ext("pi-web:subagent-notification", true), reply("stop"),
  ]), [0, 3]);
  assert.deepEqual(await anchorsOf([
    user(), reply("stop"), ext("subagent-notification", true), ext("note", true), reply("stop"),
  ]), [0, 2]);
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


test("a running ! command previews its last 20 lines, pi's TUI PREVIEW_LINES", async () => {
  const { liveOutputPreview } = await loadSubject();
  const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n";
  assert.equal(liveOutputPreview(output), Array.from({ length: 20 }, (_, i) => `line ${i + 6}`).join("\n"));
  assert.equal(liveOutputPreview("one\n"), "one");
});

test("a stopped reply is marked once it ends, with or without text or a tool call", async () => {
  const { isAssistantAborted } = await loadSubject();
  const stopped = { ...assistant([{ type: "text", text: "Half an ans" }]), stopReason: "aborted", errorMessage: "Request aborted" };
  assert.equal(isAssistantAborted(stopped), true);
  assert.equal(isAssistantAborted({ ...stopped, content: [] }), true);
  // Stopped while it streamed a tool call's arguments: the call never runs.
  assert.equal(isAssistantAborted({ ...stopped, content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] }), true);
  assert.equal(isAssistantAborted(stopped, { isStreaming: true }), false);
  assert.equal(isAssistantAborted({ ...stopped, stopReason: "stop" }), false);
});
