/**
 * Whether a thought that has been said and moved on from stays on screen.
 *
 * Off by default. A finished thought is not shown, and that is what lets a
 * run's tool calls read as one thing instead of a list interrupted on every
 * other line — the calls become neighbours and merge, and a running turn stops
 * growing without bound.
 *
 * Turning it on brings every thought back, and with it the cost, which the
 * settings page spells out where the switch is: the transcript gets long, and a
 * run's calls no longer merge, because a thought between two of them ends the
 * run. The thought in progress is shown either way — it is what is happening
 * now, and it is the only one there is while the model is still writing it.
 */

const STORAGE_KEY = "pi-thinking-visible";

/** Announced so an already-mounted transcript picks the change up at once. */
export const THINKING_VISIBLE_EVENT = "pi-thinking-visible-changed";

export function isThinkingVisible(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setThinkingVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(visible));
  } catch {
    // Nothing was saved, so there is no change to announce.
    return;
  }
  window.dispatchEvent(new Event(THINKING_VISIBLE_EVENT));
}
