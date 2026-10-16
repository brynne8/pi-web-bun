import assert from "node:assert/strict";
import test from "node:test";
import { handleGlobalEscape, registerAbortHandler } from "./useKeyboardShortcuts.ts";

function keydown(key, { tagName = "BUTTON", defaultPrevented = false, className = "", isComposing = false } = {}) {
  return {
    key,
    target: { tagName, classList: { contains: (name) => className.split(" ").includes(name) } },
    defaultPrevented,
    isComposing,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});

test("an Escape the composer did not act on still stops the run", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // ChatInput marks every Escape it acts on, so one that gets here is a key it never saw: a frame
  // after Enter, while its props still said no run was going. It still means stop.
  const composer = { tagName: "TEXTAREA", className: "chat-input-textarea" };
  assert.equal(handleGlobalEscape(keydown("Escape", composer)), true);
  assert.equal(stopped, 1);
  // An IME's Escape belongs to the composition; another field's belongs to the field.
  assert.equal(handleGlobalEscape(keydown("Escape", { ...composer, isComposing: true })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { ...composer, defaultPrevented: true })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT", className: "sidebar-search" })), false);
  assert.equal(stopped, 1);
});
