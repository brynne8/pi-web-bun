import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelBuiltinCommandFocusOnPointerDown,
  restoreBuiltinCommandFocus,
  runBuiltinCommand,
} from "../lib/composer-builtin-command.ts";

// The composer's fieldset is disabled while a `/command` runs, which blurs the editor.
// The command remembers whose focus it took and gives it back on the enabling commit,
// unless the command or the user moved it somewhere else meanwhile.

/** The browser as the focus restore sees it, with the commits the page makes. */
function composer({ focused = true } = {}) {
  const body = {};
  const other = {};
  const listeners = new Map();
  const document = {
    body,
    activeElement: body,
    querySelector: () => null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  let disabled = false;
  let resolve;
  let reject;
  let focusCount = 0;
  const textarea = {
    isConnected: true,
    focus(options) {
      assert.equal(disabled, false, "focus must wait for the fieldset's enabling commit");
      assert.deepEqual(options, { preventScroll: true });
      document.activeElement = textarea;
      focusCount++;
    },
  };
  document.activeElement = focused ? textarea : other;
  const focusRef = { current: null };
  const pendingRef = { current: false };
  const valueRef = { current: "/compact" };
  const attachedImagesRef = { current: [] };
  const scope = {
    document, textarea, focusRef, pendingRef, valueRef,
    setPending(value) { scope.disabled = value; },
    disabled: false,
  };
  const run = (msg) => runBuiltinCommand(msg, {
    document,
    textarea,
    attachedImages: [],
    onBuiltinCommand: () => new Promise((done, fail) => { resolve = done; reject = fail; }),
    valueRef,
    attachedImagesRef,
    focusRef,
    pendingRef,
    setPending: (value) => { scope.disabled = value; },
    canClearBuiltinCommandInput: (value, count, submitted) => value === submitted && count === 0,
    clearInput: () => { valueRef.current = ""; },
  });
  // The browser blurs a focused descendant when React commits disabled=true.
  let stopWatching;
  function commit() {
    stopWatching?.();
    disabled = scope.disabled;
    if (disabled && document.activeElement === textarea) document.activeElement = body;
    if (disabled) stopWatching = cancelBuiltinCommandFocusOnPointerDown(document, focusRef);
    else restoreBuiltinCommandFocus(document, focusRef);
  }
  return {
    pointerDown: (target) => listeners.get("pointerdown")?.({ target }),
    document, textarea, other, valueRef, commit,
    run,
    finish: (result = { handled: true }) => resolve(result),
    fail: (error) => reject(error),
    focusCount: () => focusCount,
    stopWatching: () => stopWatching?.(),
  };
}

for (const [name, result] of [
  ["/compact", { handled: true, action: "compact" }],
  ["a refused command", { handled: true, error: "No active session" }],
  ["an extension command falling through", { handled: false }],
]) {
  test(`${name} restores the composer's lost focus after unlocking`, async () => {
    const c = composer();
    const pending = c.run("/compact");
    c.commit();
    assert.equal(c.document.activeElement, c.document.body);
    assert.equal(c.focusCount(), 0);
    c.finish(result);
    await pending;
    assert.equal(c.focusCount(), 0, "the async finally runs before React enables the fieldset");
    c.commit();
    assert.equal(c.document.activeElement, c.textarea);
    assert.equal(c.valueRef.current, result.handled && !result.error ? "" : "/compact");
    c.document.activeElement = c.document.body;
    c.commit();
    assert.equal(c.focusCount(), 1, "the focus request is consumed once");
  });
}

test("a throwing command unlocks and restores focus too", async () => {
  const c = composer();
  const pending = c.run("/compact");
  c.commit();
  c.fail(new Error("failed"));
  await assert.rejects(pending, /failed/);
  c.commit();
  assert.equal(c.document.activeElement, c.textarea);
});

for (const scenario of ["other control", "outside text", "modal", "unmounted", "already focused", "not initially focused"]) {
  test(`command completion does not steal focus: ${scenario}`, async () => {
    const c = composer({ focused: scenario !== "not initially focused" });
    const pending = c.run("/compact");
    c.commit();
    if (scenario === "other control") c.document.activeElement = c.other;
    if (scenario === "outside text") c.pointerDown(c.document.body);
    if (scenario === "modal") c.document.querySelector = () => ({});
    if (scenario === "unmounted") c.textarea.isConnected = false;
    if (scenario === "already focused") c.document.activeElement = c.textarea;
    // Even if a clicked Send button lost focus, do not invent a textarea focus request.
    if (scenario === "not initially focused") c.document.activeElement = c.document.body;
    const active = c.document.activeElement;
    c.finish();
    await pending;
    c.commit();
    assert.equal(c.document.activeElement, active);
    assert.equal(c.focusCount(), 0);
  });
}
