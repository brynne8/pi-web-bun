"use client";

import { useSyncExternalStore } from "react";

import {
  isThinkingVisible,
  setThinkingVisible,
  THINKING_VISIBLE_EVENT,
} from "@/lib/thinking-visibility";

function subscribe(onStoreChange: () => void): () => void {
  // The event covers this tab; `storage` covers another tab changing the switch,
  // which is the same reason useFontPreferences listens for both.
  window.addEventListener(THINKING_VISIBLE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(THINKING_VISIBLE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** The setting and its setter, read live so the transcript changes as it flips. */
export function useThinkingVisible(): [boolean, (visible: boolean) => void] {
  const visible = useSyncExternalStore(subscribe, isThinkingVisible, () => false);
  return [visible, setThinkingVisible];
}
