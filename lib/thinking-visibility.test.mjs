import assert from "node:assert/strict";
import test from "node:test";

import { isThinkingVisible, setThinkingVisible } from "./thinking-visibility.ts";

function installWindow() {
  const store = new Map();
  const listeners = new Set();
  const fakeWindow = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    dispatchEvent: (event) => { for (const listener of listeners) listener(event); return true; },
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
  };
  globalThis.window = fakeWindow;
  return { fakeWindow, store, listeners };
}

test("a finished thought is hidden unless the reader asks for it", () => {
  const previous = globalThis.window;
  const { store } = installWindow();
  try {
    assert.equal(isThinkingVisible(), false);
    setThinkingVisible(true);
    assert.equal(store.get("pi-thinking-visible"), "true");
    assert.equal(isThinkingVisible(), true);
    setThinkingVisible(false);
    assert.equal(isThinkingVisible(), false);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("flipping the switch announces itself, so a mounted transcript follows", () => {
  const previous = globalThis.window;
  const { listeners } = installWindow();
  try {
    let announced = 0;
    const listener = (event) => { if (event.type === "pi-thinking-visible-changed") announced += 1; };
    globalThis.window.addEventListener("pi-thinking-visible-changed", listener);
    setThinkingVisible(true);
    setThinkingVisible(false);
    assert.equal(announced, 2);
    assert.equal(listeners.size, 1);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("a blocked localStorage changes nothing and announces nothing", () => {
  const previous = globalThis.window;
  const { listeners } = installWindow();
  let announced = 0;
  globalThis.window.addEventListener("pi-thinking-visible-changed", () => { announced += 1; });
  globalThis.window.localStorage.setItem = () => { throw new Error("blocked"); };
  try {
    setThinkingVisible(true);
    assert.equal(announced, 0);
    assert.equal(isThinkingVisible(), false);
    assert.equal(listeners.size, 1);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
