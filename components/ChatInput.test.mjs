import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

import { handleComposerKeyDown } from "../lib/composer-keydown.ts";
import { handleComposerPaste } from "../lib/composer-paste.ts";
import { handleComposerFilePick } from "../lib/composer-file-pick.ts";
import { runBuiltinCommand } from "../lib/composer-builtin-command.ts";
import { handleComposerSend, handleComposerSendQueued } from "../lib/composer-send.ts";
import { chooseModel } from "../lib/model-selector-choose.ts";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  tryNative: false,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, ModelScopeWarningBanner, RUN_END_CLICK_GUARD_MS, autoGrowTextarea, scrollTextareaCaretIntoView, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, cycleListIndex, filterModelOptions, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, isRunEndStrayClick, modelSupportsImageInput, offersBuiltinSlashCommandWhileStreaming, replaceLinksWithMarkdown, readImageFile, replaceTextareaRange, stacksComposerLayout, submitsSlashCommandOnEnter } = await jiti.import("./ChatInput.tsx");
const { isBareMcpCommand } = await jiti.import("@/lib/mcp-command");
const { withSessionReferences } = await jiti.import("@/lib/session-reference-target");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
// As ChatInput.tsx imports it: on Windows jiti loads "@/lib/draft-store.ts"
// as a second copy, and ChatInput would never see the drafts set here (#1211).
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("@/lib/draft-store");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("a phone stacks the streaming buttons under the draft instead of beside it", () => {
  // Two buttons in the draft's row leave the placeholder about 150px on a 360px
  // phone. Only a streaming run has those buttons; idle keeps the icon-only send
  // button in the row, and a desktop has width for the row either way.
  assert.equal(stacksComposerLayout(false, false), false);
  assert.equal(stacksComposerLayout(false, true), false);
  assert.equal(stacksComposerLayout(true, false), false);
  assert.equal(stacksComposerLayout(true, true), true);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const cases = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    // The grace is 100 ms: half a second after the composition ended, Enter sends.
    ["a composition that ended 600 ms ago sends", { altKey: true }, { lastCompositionEndAtRef: { current: 400 } }, "followup"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter follows up", { altKey: true, ctrlKey: true }, { isMobile: true }, "followup"],
    ["mobile Cmd+Alt+Enter follows up", { altKey: true, metaKey: true }, { isMobile: true }, "followup"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Enter falls back to follow-up", {}, { onSteer: undefined }, "followup"],
    ["Alt+Enter falls back to steer", { altKey: true }, { onFollowUp: undefined }, "steer"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["pi's built-in /mcp submits at once, also while streaming", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } }] }, "send"],
    ["another extension's /mcp completes first", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "/ext/mcp.ts" } }] }, "slash"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
    ["Ctrl+Enter mode: Enter inserts a newline", {}, { enterSendMode: "ctrlEnter", isStreaming: false }, "native"],
    ["Ctrl+Enter mode: Ctrl+Enter sends", { ctrlKey: true }, { enterSendMode: "ctrlEnter", isStreaming: false }, "send"],
    ["Ctrl+Enter mode: Cmd+Enter steers", { metaKey: true }, { enterSendMode: "ctrlEnter" }, "steer"],
    ["Ctrl+Enter mode: composition grace blocks the newline", {}, { enterSendMode: "ctrlEnter", lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Ctrl+Enter mode: Enter picks a file", {}, { enterSendMode: "ctrlEnter", atMenuOpen: true, atQuery: {} }, "file"],
    ["Ctrl+Enter mode: Enter picks from history", {}, { enterSendMode: "ctrlEnter", historyMenuOpen: true }, "history"],
    ["Ctrl+Enter mode: Enter completes an exact slash command instead of sending it", {}, { enterSendMode: "ctrlEnter", isStreaming: false, slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin" }] }, "slash"],
    ["Ctrl+Enter mode: Ctrl+Enter sends an exact slash command", { ctrlKey: true }, { enterSendMode: "ctrlEnter", isStreaming: false, slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin" }] }, "send"],
    ["mobile ignores Ctrl+Enter mode for plain Enter", {}, { enterSendMode: "ctrlEnter", isMobile: true }, "native"],
    // An extension's dialog hides the menus (#1678): Enter must not pick from one the user cannot see.
    ["an open extension dialog hides slash completion", {}, { isStreaming: false, extensionUiOpen: true, slashMenuOpen: true, slashQuery: "help" }, "send"],
    ["an open extension dialog hides file completion", {}, { isStreaming: false, extensionUiOpen: true, atMenuOpen: true, atQuery: {} }, "send"],
    ["an open extension dialog hides history selection", {}, { isStreaming: false, extensionUiOpen: true, historyMenuOpen: true }, "send"],
    ["session completion takes priority", { key: "Tab" }, { hashMenuOpen: true, hashQuery: {}, hashMatches: [{}] }, "hash"],
    ["an open extension dialog hides session completion", { key: "Tab" }, { extensionUiOpen: true, hashMenuOpen: true, hashQuery: {}, hashMatches: [{}] }, "native"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    handleComposerKeyDown({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    }, {
      isMobile: false, isStreaming: true, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 }, now: () => 1000,
      extensionUiOpen: false,
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      hashMenuOpen: false, hashQuery: null, hashMatches: [], hashActiveIndex: 0, applyHashCompletion() { action = "hash"; },
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      submitsSlashCommandOnEnter, value: "",
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      setSlashMenuOpen() {}, setHistoryMenuOpen() {}, setAtMenuOpen() {},
      setHistoryActiveIndex() {}, setSlashActiveIndex() {}, setAtActiveIndex() {},
      getNextSlashIndex: () => 0, cycleListIndex: (index) => index,
      ...state,
    });
    assert.equal(action, expected, name);
  }
});

test("file mention insertion uses one native undoable edit", () => {
  const originalDocument = globalThis.document;
  const calls = [];
  const textarea = {
    value: '@"my/"',
    selectionStart: 5,
    selectionEnd: 5,
    focus() { calls.push(["focus"]); },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
      calls.push(["selection", start, end]);
    },
  };
  globalThis.document = {
    execCommand(command, _showUi, text = "") {
      calls.push(["command", command, text]);
      if (command === "delete") {
        textarea.value = textarea.value.slice(0, --textarea.selectionStart) + textarea.value.slice(textarea.selectionEnd);
        textarea.selectionEnd = textarea.selectionStart;
      } else if (command === "insertText") {
        textarea.value = textarea.value.slice(0, textarea.selectionStart) + text + textarea.value.slice(textarea.selectionEnd);
        textarea.selectionStart += text.length;
        textarea.selectionEnd = textarea.selectionStart;
      } else if (command === "forwardDelete") {
        textarea.value = textarea.value.slice(0, textarea.selectionStart) + textarea.value.slice(textarea.selectionStart + 1);
      }
      return true;
    },
  };

  try {
    replaceTextareaRange(textarea, 0, 6, '@"my dir/"', 9);
    assert.equal(textarea.value, '@"my dir/"');
    assert.deepEqual(calls, [
      ["focus"],
      ...Array.from({ length: 5 }, () => ["command", "delete", ""]),
      ["command", "insertText", '@"my dir/"'],
      ["command", "forwardDelete", ""],
      ["selection", 9, 9],
    ]);

    calls.length = 0;
    Object.assign(textarea, { value: "hello selected", selectionStart: 6, selectionEnd: 14 });
    replaceTextareaRange(textarea, 6, 14, "@file ");
    assert.equal(textarea.value, "hello @file ");
    assert.deepEqual(calls, [
      ["focus"],
      ["selection", 6, 14],
      ["command", "insertText", "@file "],
    ]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("file mention insertion falls back to a plain edit when execCommand refuses", () => {
  const originalDocument = globalThis.document;
  const events = [];
  const textarea = {
    value: "AAA @re BBB",
    selectionStart: 7,
    selectionEnd: 7,
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    setRangeText(text, start, end, mode) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      if (mode === "end") this.selectionStart = this.selectionEnd = start + text.length;
    },
    dispatchEvent(event) { events.push([event.type, event.bubbles]); return true; },
  };
  globalThis.document = { execCommand: () => false };

  try {
    replaceTextareaRange(textarea, 4, 7, "@readme.md ");
    assert.equal(textarea.value, "AAA @readme.md  BBB");
    assert.equal(textarea.selectionStart, 15);
    assert.deepEqual(events, [["input", true]]);

    events.length = 0;
    Object.assign(textarea, { value: "hello selected", selectionStart: 6, selectionEnd: 14 });
    replaceTextareaRange(textarea, 6, 14, "@file ");
    assert.equal(textarea.value, "hello @file ");
    assert.deepEqual(events, [["input", true]]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test("a plain-text paste the browser dropped is inserted from the event's own text (#1513)", () => {
  // inputFollows: the browser's own insertion fired input (handleInput clears the ref).
  function paste({ text, html = "", links = [], inputFollows = false, connected = true }) {
    const timers = [];
    const frames = [];
    const inserted = [];
    const caret = { focused: false, range: null };
    const pendingPasteRef = { current: null };
    const nativeEvent = { defaultPrevented: false };
    handleComposerPaste({
      clipboardData: { items: [], getData: (type) => (type === "text/plain" ? text : type === "text/html" ? html : "") },
      currentTarget: {
        value: "a draft",
        selectionStart: 2,
        selectionEnd: 5,
        isConnected: connected,
        focus() { caret.focused = true; },
        setSelectionRange(start, end) { caret.range = [start, end]; },
      },
      nativeEvent,
      preventDefault() { nativeEvent.defaultPrevented = true; },
    }, {
      processImageFiles() {},
      pendingPasteRef,
      setTimeout(callback, delay) { timers.push([callback, delay]); },
      replaceTextareaRange(ta, start, end, value) { inserted.push([start, end, value]); },
      replaceLinksWithMarkdown,
      valueRef: { current: "" }, setValue() {}, setHistoryMenuOpen() {}, updateAtQuery() {}, updateHashQuery() {},
      requestAnimationFrame(callback) { frames.push(callback); },
      scrollTextareaCaretIntoView() {},
      DOMParser: class {
        parseFromString() {
          return {
            body: {},
            querySelectorAll: () => links.map(([label, href]) => ({ textContent: label, getAttribute: () => href })),
            createRange: () => ({ setStart() {}, setEndBefore() {}, toString: () => "" }),
          };
        }
      },
    });
    if (inputFollows) pendingPasteRef.current = null;
    for (const [callback, delay] of timers) {
      assert.equal(delay, 0);
      callback();
    }
    for (const callback of frames) callback();
    return { inserted, prevented: nativeEvent.defaultPrevented, pending: pendingPasteRef.current, caret };
  }

  // The native paste stays in charge: never prevented, nothing inserted twice.
  assert.deepEqual(paste({ text: "dictated", inputFollows: true }), { inserted: [], prevented: false, pending: null, caret: { focused: false, range: null } });
  // Dropped by the browser: the delivered text replaces the selection at paste time.
  assert.deepEqual(paste({ text: "dictated" }), { inserted: [[2, 5, "dictated"]], prevented: false, pending: null, caret: { focused: false, range: null } });
  // Rich text without links pastes natively too, and is recovered the same way.
  assert.deepEqual(paste({ text: "rich", html: "<b>rich</b>" }).inserted, [[2, 5, "rich"]]);
  // The link path takes the paste over itself: nothing to recover, and the caret lands
  // right after the Markdown it wrote, in a focused editor.
  const markdown = "[rich](https://example.com)";
  assert.deepEqual(paste({ text: "rich", html: "<a>rich</a>", links: [["rich", "https://example.com"]] }), {
    inserted: [],
    prevented: true,
    pending: null,
    caret: { focused: true, range: [2 + markdown.length, 2 + markdown.length] },
  });
  assert.deepEqual(paste({ text: "", html: "" }).inserted, []);
  assert.deepEqual(paste({ text: "gone", connected: false }).inserted, []);
});

test("file mention arrows wrap around the match list", () => {
  function move(key, atActiveIndex, length) {
    let next = null;
    handleComposerKeyDown({
      key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      preventDefault() {},
    }, {
      isMobile: false, isStreaming: false, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 }, now: () => 1000,
      extensionUiOpen: false,
      historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
      atMenuOpen: true, atQuery: {}, atMatches: Array.from({ length }, () => ({})), atActiveIndex,
      hashMenuOpen: false, hashQuery: null, hashMatches: [], hashActiveIndex: 0, applyHashCompletion() {}, setHashMenuOpen() {}, setHashActiveIndex() {},
      onSteer() {}, onFollowUp() {},
      sendQueued() {}, handleSend() {},
      applySlashCommand() {},
      submitsSlashCommandOnEnter() { return false; }, value: "@file",
      setSlashMenuOpen() {}, setAtMenuOpen() {},
      applyAtCompletion() {},
      applyHistoryInput() {},
      cycleListIndex,
      setAtActiveIndex(update) {
        next = typeof update === "function" ? update(atActiveIndex) : update;
      },
      setHistoryMenuOpen() {}, setHistoryActiveIndex() {}, setSlashActiveIndex() {},
      getNextSlashIndex: () => 0,
    });
    return next;
  }

  assert.equal(move("ArrowDown", 0, 3), 1);
  assert.equal(move("ArrowDown", 2, 3), 0);
  assert.equal(move("ArrowUp", 0, 3), 2);
  assert.equal(move("ArrowUp", 1, 3), 0);
  assert.equal(move("ArrowDown", 0, 1), 0);
  assert.equal(move("ArrowDown", 0, 0), 0);
});

test("cycleListIndex wraps in both directions", () => {
  assert.equal(cycleListIndex(0, 3, 1), 1);
  assert.equal(cycleListIndex(2, 3, 1), 0);
  assert.equal(cycleListIndex(0, 3, -1), 2);
  assert.equal(cycleListIndex(1, 3, -1), 0);
  assert.equal(cycleListIndex(0, 1, 1), 0);
  assert.equal(cycleListIndex(4, 0, 1), 0);
  assert.equal(cycleListIndex(-1, 4, 1), 0);
});

test("names the follow-up timing and shortcut when it is the only delivery choice", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onFollowUp() {}, isStreaming: true,
    })),
  );

  assert.match(html, /title="Delivered only once the agent has no tool calls left and would otherwise stop, so the current task finishes untouched \(Alt\/Option\+Enter\)"/);
  assert.match(html, /aria-keyshortcuts="Alt\+Enter"/);
});

test("shows one delivery button and folds the other timing behind its menu", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, isStreaming: true,
    })),
  );

  // Enter's behavior is the primary action; the closed menu holds one label.
  assert.match(html, /aria-keyshortcuts="Enter"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.equal((html.match(/>Steer<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Follow-up/);

  // The hint a row shows is the language's own words, in the title of the button it draws. The
  // menu is closed here, so only the primary row is on the page; the follow-up row is the same
  // component one row down, and opening the menu is a click this render cannot make.
  assert.match(html, /title="Delivered as soon as this reply and the tool calls it started finish/);
});

test("keeps Stop out of the controls row so a second click cannot reach compaction", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {},
      onCompact() {}, onToolPresetChange() {}, onThinkingLevelChange() {},
      isStreaming: true,
    })),
  );

  const stop = html.indexOf('aria-label="Stop agent"');
  assert.notEqual(stop, -1);
  assert.ok(stop < html.indexOf("chat-input-controls"), "Stop sits in the composer row, clear of the controls bar");

  // Context controls keep their coordinates and go inert instead of leaving a slot
  // for compaction to appear under the pointer that just pressed Stop.
  for (const label of ["Compact context", "Change tool preset"]) {
    const at = html.indexOf(`aria-label="${label}"`);
    assert.notEqual(at, -1, `${label} stays rendered`);
    const tag = html.slice(html.lastIndexOf("<button", at), at);
    assert.match(tag, /disabled=""/);
    assert.doesNotMatch(tag, /title=/);
    assert.match(html.slice(html.lastIndexOf("<div", html.lastIndexOf("<button", at))), /title="Available when this run finishes"/);
  }
});

test("returns the context controls once the run settles", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onCompact() {}, isStreaming: false,
    })),
  );

  assert.match(html, /title="Compact context"/);
  assert.doesNotMatch(html, /aria-label="Stop agent"/);
});

test("scrolls a long queue inside its own box, under the count and Recall (#1428)", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onSteer() {}, onFollowUp() {}, onRecallQueue() {}, isStreaming: true,
      queuedMessages: { steering: Array.from({ length: 19 }, (_, i) => `steer-${i}`), followUp: ["follow-up-0"] },
    })),
  );
  const rows = html.match(/<div style="max-height:min\(180px[^"]*overflow-y:auto[^"]*">(.*)$/s);
  assert.ok(rows, "queued rows sit in a capped scroll box");
  assert.match(html.slice(0, rows.index), /Queued · 20<\/span>.*Recall to input<\/button>/s);
  assert.deepEqual([...rows[1].matchAll(/<div title="([^"]+)"/g)].map((match) => match[1]),
    [...Array.from({ length: 19 }, (_, i) => `steer-${i}`), "follow-up-0"]);
});

test("the composer stays editable while compacting and says messages queue", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, isCompacting: true,
    })),
  );

  assert.doesNotMatch(html, /<textarea[^>]*\bdisabled\b/);
  assert.match(html, /placeholder="Compacting… messages queue until it finishes"/);
});

test("ignores a pointer click that reaches Stop's slot just as the run ends", () => {
  assert.equal(isRunEndStrayClick(1, 0), true);
  assert.equal(isRunEndStrayClick(2, RUN_END_CLICK_GUARD_MS - 1), true);
  assert.equal(isRunEndStrayClick(1, RUN_END_CLICK_GUARD_MS), false);
  assert.equal(isRunEndStrayClick(1, Number.POSITIVE_INFINITY), false, "no run has ended yet");
  assert.equal(isRunEndStrayClick(0, 0), false, "Enter/Space on a focused button is never a stray click");
  assert.ok(RUN_END_CLICK_GUARD_MS <= 700, "a deliberate click after a run must not wait noticeably");

  // Upstream's fix for #1131 stays as a second line of defence. Stop no longer shares
  // the slot left of the sound toggle — it sits in the composer row, and the controls
  // keep their place inert through a run — but the phone's More controls popup still
  // re-enables Compact in place under a finger that waited on the run. That the buttons
  // reach for `isStrayClick` is wiring a server render cannot see: the rule is asserted
  // here, and the click itself is a browser test's.
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Model error/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("renders enabledModels scope warnings", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelScopeWarningBanner, {
        warnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.match(html, /Model scope warning/);
  assert.match(html, /ghost-gateway/);
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelScopeWarningBanner, { warnings: [] })),
    ),
    "",
  );
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />No models</);
  assert.match(html, /title="No available models"/);
});

test("renders the read-only tool preset as the active selection", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: read-only"/);
  assert.match(html, />read-only<\/span>/);
});

test("renders the empty tool preset as Chat only", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        isStreaming: false,
        toolPreset: "none",
      }),
    ),
  );

  assert.match(html, /title="Change tool preset: Chat only"/);
  assert.match(html, />Chat only<\/span>/);
});

test("the attach button takes any file when the chat handles them, and images only otherwise (#1101)", () => {
  const render = (props) => renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, isStreaming: false, ...props,
    })),
  );
  const fileInput = (html) => html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? "";

  const html = render({ onAttachFiles() {} });
  assert.match(html, /title="Attach files"/);
  assert.match(fileInput(html), /multiple=""/);
  // No accept list and no capture: phones offer files, the photo library and the camera.
  assert.doesNotMatch(fileInput(html), /accept=|capture=/);

  assert.match(fileInput(render({})), /accept="image\/\*"/);
});

test("picked files go to the chat's attach handler, or attach as images without one (#1101)", () => {
  const photo = new File(["x"], "photo.png", { type: "image/png" });
  const report = new File(["x"], "report.pdf", { type: "application/pdf" });
  const pick = (context) => {
    const calls = { attached: [], images: [] };
    const target = { files: [photo, report], value: "C:\\fakepath\\photo.png" };
    handleComposerFilePick({ target }, {
      processImageFiles: (files) => calls.images.push([...files]),
      ...context(calls),
    });
    return { ...calls, value: target.value };
  };

  assert.deepEqual(
    pick((calls) => ({ onAttachFiles: (files) => calls.attached.push([...files]) })),
    { attached: [[photo, report]], images: [], value: "" },
  );
  assert.deepEqual(pick(() => ({ onAttachFiles: undefined })), { attached: [], images: [[photo, report]], value: "" });
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="Switching model"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("the live model selector can reapply its current model without changing draft-field selection behavior", () => {
  const option = { provider: "fixture", modelId: "same-id", name: "Fixture" };
  for (const [active, automatic, live, expected] of [
    [true, false, true, "reselect"],
    [true, false, false, null],
    [true, true, true, "change"],
    [false, false, true, "change"],
  ]) {
    const calls = [];
    chooseModel(option, {
      value: active ? option : null,
      isAutoSelection: automatic,
      setOpen: (value) => calls.push(["open", value]),
      setFilter: (value) => calls.push(["filter", value]),
      onChange: (provider, id) => calls.push(["change", provider, id]),
      onReselect: live ? (provider, id) => calls.push(["reselect", provider, id]) : undefined,
    });
    assert.deepEqual(calls, [["open", false], ["filter", ""], ...(expected ? [[expected, option.provider, option.modelId]] : [])]);
  }
  // The selector's reselect path is what a pick of the active model reaches; that this composer
  // hands its own `onModelChange` in is wiring, which no server render shows.
});

test("filters model options by name, id, provider and provider/id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
    { provider: "relay-a", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "OpenAI"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, " anthropic/claude "), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "Relay-A/GPT"), [options[3]]);
  assert.deepEqual(filterModelOptions(options, "gpt-5.4"), [options[2], options[3]]);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("reads attached images unchanged, leaving resizing to pi", async () => {
  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
  };
  let bitmapCalls = 0;
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 6000, height: 4000, close() {} };
  };

  try {
    assert.deepEqual(await readImageFile({ size: 8 * 1024 * 1024, type: "image/png" }, "image/png"), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.equal(bitmapCalls, 0);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("locks built-in command submission until it settles", async () => {
  let resolve;
  const pendingStates = [];
  const cleared = [];
  const pendingRef = { current: false };
  const callback = (msg) => runBuiltinCommand(msg, {
    document: { activeElement: null },
    textarea: null,
    attachedImages: [],
    attachedImagesRef: { current: [] },
    onBuiltinCommand: () => new Promise((done) => { resolve = done; }),
    valueRef: { current: "/reload" },
    focusRef: { current: null },
    pendingRef,
    setPending: (value) => pendingStates.push(value),
    canClearBuiltinCommandInput,
    clearInput: () => cleared.push("/reload"),
  });

  const first = callback("/reload");
  assert.deepEqual(pendingStates, [true]);
  assert.equal(await callback("/reload"), true);
  assert.deepEqual(pendingStates, [true]);
  resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(pendingStates, [true, false]);
  assert.deepEqual(cleared, ["/reload"]);
});

test("keeps an issued built-in out of stored drafts until it settles", async () => {
  let resolve;
  const holds = [];
  const pendingRef = { current: false };
  const draftKeyRef = { current: "session-a" };
  const run = (msg) => runBuiltinCommand(msg, {
    document: { activeElement: null },
    textarea: null,
    attachedImages: [],
    attachedImagesRef: { current: [] },
    onBuiltinCommand: () => new Promise((done) => { resolve = done; }),
    valueRef: { current: "/reload" },
    focusRef: { current: null },
    pendingRef,
    setPending: () => {},
    canClearBuiltinCommandInput,
    clearInput: () => {},
    draftKeyRef,
    holdStoredDraft: (key) => {
      holds.push(key);
      return () => holds.push(`released ${key}`);
    },
  });

  const first = run("/reload");
  assert.deepEqual(holds, ["session-a"]);
  assert.equal(await run("/reload"), true);
  assert.deepEqual(holds, ["session-a"], "a second press takes no second hold");
  resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(holds, ["session-a", "released session-a"]);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  // /btw forks the session at file level, so a side question during a long
  // parent run is the primary use case (ADR 0007).
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/btw"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/btw why did the test fail?"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/auto-compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("a bare /mcp reaches the built-in handler while a run is active", () => {
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/compact"), false);
  // Subcommands act on the session's connections and are queued like any message.
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp login docs"), false);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp:1"), false);
  // The built-in list itself is unchanged: /mcp is not one of the composer's built-ins.
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/mcp"), false);
});

test("Enter on pi's built-in /mcp submits it at once; other extension commands still complete first", () => {
  const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
  const otherMcp = { ...builtinMcp, sourceInfo: { ...builtinMcp.sourceInfo, path: "/ext/mcp.ts" } };
  const copy = { name: "copy", description: "", source: "builtin", availableWhileStreaming: true };
  const compact = { name: "compact", description: "", source: "builtin" };

  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, false), true);
  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, true), true);
  assert.equal(submitsSlashCommandOnEnter("/mc", builtinMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/mcp", otherMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/deploy", { ...otherMcp, name: "deploy" }, false), false);
  // The composer's built-ins keep their rule: typed in full, and while streaming only those allowed then.
  assert.equal(submitsSlashCommandOnEnter("/copy", copy, true), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, false), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, true), false);
  assert.equal(submitsSlashCommandOnEnter("/co", copy, false), false);
});

test("while a run streams, a bare /mcp opens Settings or is queued as before", async () => {
  const run = async (value, handled, { mode = "steer", images = [], references = [] } = {}) => {
    const calls = { builtin: [], prompts: [], steered: [], cleared: 0 };
    const sendQueued = (queuedMode) => handleComposerSendQueued(queuedMode, {
      value,
      attachedImages: images,
      attachedReferences: references,
      isStreaming: true,
      onBuiltinCommand: () => ({}),
      onAudioUnlock() {},
      clearInput() { calls.cleared += 1; },
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      canRunBuiltinSlashCommandWhileStreaming,
      isBareMcpCommand,
      onPromptWithStreamingBehavior: (message, behavior, attached) => calls.prompts.push([message, behavior, attached?.length ?? 0]),
      onSteer: (message) => calls.steered.push(message),
      onFollowUp: (message) => calls.steered.push(message),
    });
    sendQueued(mode);
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
  };

  // Owned: Settings opened, nothing queued, the handler clears the input itself.
  assert.deepEqual(await run("/mcp", true), { builtin: ["/mcp"], prompts: [], steered: [], cleared: 0 });
  // Another extension's /mcp: queued exactly as before.
  assert.deepEqual(await run("/mcp", false), { builtin: ["/mcp"], prompts: [["/mcp", "steer", 0]], steered: [], cleared: 1 });
  assert.deepEqual(await run("/mcp", false, { mode: "followup" }), { builtin: ["/mcp"], prompts: [["/mcp", "followUp", 0]], steered: [], cleared: 1 });
  // Subcommands and a /mcp with images never reach the handler.
  assert.deepEqual(await run("/mcp login docs", true), { builtin: [], prompts: [["/mcp login docs", "steer", 0]], steered: [], cleared: 1 });
  assert.deepEqual(await run("/mcp", true, { images: [{}] }), { builtin: [], prompts: [["/mcp", "steer", 1]], steered: [], cleared: 1 });
  // The composer's own built-ins are unchanged.
  assert.deepEqual(await run("/copy", true), { builtin: ["/copy"], prompts: [], steered: [], cleared: 0 });
  // A steer or follow-up carries the composer's session chips, even alone.
  const reference = { id: "11111111-2222-3333-4444-555555555555", title: "old chat" };
  const token = "[old chat](#session:11111111-2222-3333-4444-555555555555)";
  assert.deepEqual(await run("see this", false, { references: [reference] }), { builtin: [], prompts: [], steered: [`see this\n\n${token}`], cleared: 1 });
  assert.deepEqual(await run("", false, { mode: "followup", references: [reference] }), { builtin: [], prompts: [], steered: [token], cleared: 1 });
  // The composer's own send path spells the same token the server expands.
  assert.equal(withSessionReferences("see this", [reference]), `see this\n\n${token}`);
  assert.equal(withSessionReferences("", [reference]), token);
});

test("handleSend lets a handled /mcp through while streaming and sends an unowned one when idle", async () => {
  const run = async (value, { isStreaming, handled }) => {
    const calls = { builtin: [], sent: [] };
    await handleComposerSend({
      value,
      attachedImages: [],
      attachedReferences: [],
      isStreaming,
      onBuiltinCommand: () => ({}),
      onAudioUnlock() {},
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      clearInput() {},
      onSend: (message) => calls.sent.push(message),
      offersBuiltinSlashCommandWhileStreaming,
    });
    return calls;
  };
  assert.deepEqual(await run("/mcp", { isStreaming: true, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: false }), { builtin: ["/mcp"], sent: ["/mcp"] });
  // Streaming without steer handlers keeps any other message in the composer, as before.
  assert.deepEqual(await run("/mcp login", { isStreaming: true, handled: false }), { builtin: [], sent: [] });
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("a compact error can be dismissed when the composer is given a handler", () => {
  const render = (props) => renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: "Nothing to compact (session too small)",
        ...props,
      }),
    ),
  );

  assert.match(render({ onDismissCompactError() {} }), /aria-label="Dismiss compaction error"/);
  assert.doesNotMatch(render({}), /Dismiss compaction error/);
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("Images may not be sent"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /The selected model \(Text Only\) does not support image input/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("selector rows keep the default star and the floating save button in one gutter", async () => {
  const { SelectorRow } = await jiti.import("./SelectorRow.tsx");
  const star = (isDefault) => ({ isDefault, saveLabel: "Save as default", defaultLabel: "Default", onSave: () => {} });
  const row = (props) => renderToStaticMarkup(React.createElement(SelectorRow, {
    active: false,
    onSelect: () => {},
    ...props,
  }, "Alpha"));

  const savable = row({ star: star(false) });
  assert.match(savable, /role="option"/);
  assert.match(savable, /aria-label="Save as default"/);
  // Hidden until hover or focus, but kept out of the row's text by the gutter.
  assert.match(savable, /opacity:0/);
  assert.match(savable, /tabindex="-1"/);
  assert.match(savable, /padding:7px 36px 7px 12px/);
  assert.doesNotMatch(savable, /aria-label="Default"/);

  // The default row shows a static marker in the same spot and no button.
  const saved = row({ star: star(true) });
  assert.match(saved, /role="img" aria-label="Default"/);
  assert.match(saved, /fill="currentColor"/);
  assert.doesNotMatch(saved, /Save as default/);

  const plain = row({});
  assert.doesNotMatch(plain, /Save as default|aria-label="Default"/);
  assert.match(plain, /padding:7px 12px/);
  // Rows without a star still line up with starred ones in the same menu.
  assert.match(row({ gutter: true }), /padding:7px 36px 7px 12px/);

  const active = row({ active: true });
  assert.match(active, /aria-selected="true"/);
  assert.doesNotMatch(active, /border-left/);
});

test("grows the composer to its text and hides the scrollbar until the text is taller than the box", () => {
  const fake = (value, scrollHeight, clientHeight) => ({
    value,
    style: { height: "", overflowY: "" },
    scrollTop: 0,
    get scrollHeight() { return scrollHeight; },
    clientHeight,
  });

  const empty = fake("", 48, 24);
  autoGrowTextarea(empty);
  assert.equal(empty.style.height, "24px", "an empty box keeps the height CSS gives it, not its placeholder's lines");
  assert.equal(empty.style.overflowY, "hidden", "a wrapped placeholder never scrolls an empty composer");

  const oneLine = fake("hi", 24, 24);
  autoGrowTextarea(oneLine);
  assert.equal(oneLine.style.height, "24px");
  assert.equal(oneLine.style.overflowY, "hidden");

  const tall = fake("lots", 320, 24);
  autoGrowTextarea(tall);
  assert.equal(tall.style.height, "200px", "the box caps at 200 px");
  assert.equal(tall.style.overflowY, "auto", "capped text scrolls");
});

test("measures the composer once, so a keystroke costs one layout and not two", () => {
  // Reading a size after a style write forces the browser to lay out again, and
  // the grow runs in a layout effect on every keystroke: each such pair is a
  // reflow before the frame can paint.
  const counting = (value, scrollHeight, clientHeight) => {
    const log = [];
    const written = {};
    const box = {
      log,
      value,
      style: {
        set height(v) { log.push("w:height"); written.height = v; },
        get height() { return written.height; },
        set overflowY(v) { log.push("w:overflowY"); written.overflowY = v; },
        get overflowY() { return written.overflowY; },
      },
      set scrollTop(v) { log.push("w:scrollTop"); written.scrollTop = v; },
      get scrollTop() { return written.scrollTop; },
      get scrollHeight() { log.push("r:scrollHeight"); return scrollHeight; },
      get clientHeight() { log.push("r:clientHeight"); return clientHeight; },
    };
    return box;
  };

  for (const [label, box] of [["text", counting("hi", 320, 24)], ["empty", counting("", 48, 24)]]) {
    autoGrowTextarea(box);
    let forced = 0;
    let wrote = false;
    for (const op of box.log) {
      if (op.startsWith("w:")) wrote = true;
      else if (wrote) {
        forced++;
        wrote = false;
      }
    }
    assert.equal(forced, 1, `${label}: one forced layout per grow, got ${forced} — ${box.log.join(" ")}`);
  }
});

test("a capped composer keeps its scroll while it regrows, so a caret at the end stays visible", () => {
  // As a browser does: an "auto" height fits the whole text, which clamps
  // scrollTop to 0.
  const fake = (value, scrollHeight, clientHeight) => {
    let height = "";
    const ta = {
      value,
      style: {
        overflowY: "",
        get height() { return height; },
        set height(next) { height = next; if (next === "auto") ta.scrollTop = 0; },
      },
      scrollTop: 40,
      get scrollHeight() { return scrollHeight; },
      clientHeight,
    };
    return ta;
  };

  const tall = fake("lots of lines", 320, 24);
  autoGrowTextarea(tall);
  assert.equal(tall.style.height, "200px");
  assert.equal(tall.scrollTop, 40, "the auto-height reset does not leave the box scrolled back to the top");
});

test("a re-wrapped draft keeps a caret at the end visible instead of replaying the old offset", () => {
  // As when a run's Steer / Follow-up / Side-chat buttons narrow the composer:
  // the text wraps taller with no keystroke, so no browser caret scroll comes.
  const ta = {
    value: "many\nlines",
    selectionEnd: "many\nlines".length,
    scrollTop: 158,
    style: { height: "", overflowY: "" },
    get scrollHeight() { return 1075; },
    clientHeight: 200,
  };
  autoGrowTextarea(ta);
  assert.equal(ta.scrollTop, 1075, "an end caret follows the text to its bottom");
});

test("a caret inside the text keeps the scroll it had while the box regrows", () => {
  const ta = {
    value: "many\nlines",
    selectionEnd: 3,
    scrollTop: 158,
    style: { height: "", overflowY: "" },
    get scrollHeight() { return 1075; },
    clientHeight: 200,
  };
  autoGrowTextarea(ta);
  assert.equal(ta.scrollTop, 158, "a mid-text caret cannot be positioned, so the old offset stays");
});

test("a programmatic caret at the end scrolls an overflowing box to its bottom, a mid-text caret does not", () => {
  const fake = (value, selectionEnd, scrollHeight) => ({
    value,
    selectionEnd,
    scrollTop: 0,
    get scrollHeight() { return scrollHeight; },
  });

  const atEnd = fake("many\nlines", 10, 320);
  scrollTextareaCaretIntoView(atEnd);
  assert.equal(atEnd.scrollTop, 320, "a caret at the very end scrolls to the bottom");

  const mid = fake("many\nlines", 3, 320);
  scrollTextareaCaretIntoView(mid);
  assert.equal(mid.scrollTop, 0, "a mid-text caret leaves the scroll alone");
});
