// The composer's key handling: what Enter, Tab, the arrows and Escape do, and which of
// them a popup menu or an IME composition takes first. Kept out of the component so a
// test can drive it with a plain event object.

export const COMPOSITION_END_ENTER_GRACE_MS = 100;

/** The part of a keyboard event the composer's handler reads. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
  preventDefault(): void;
}

export interface ComposerKeyDownDeps<SlashCommand = unknown, AtMatch = unknown> {
  isMobile: boolean;
  enterSendMode: "enter" | "ctrlEnter";
  isStreaming: boolean;
  /** When the last IME composition ended, on `Date.now()`'s clock. */
  lastCompositionEndAtRef: { current: number };
  isComposingRef: { current: boolean };
  now: () => number;
  historyMenuOpen: boolean;
  extensionUiOpen: boolean;
  inputHistory: string[];
  historyActiveIndex: number;
  setHistoryActiveIndex: (index: number | ((index: number) => number)) => void;
  setHistoryMenuOpen: (open: boolean) => void;
  applyHistoryInput: (text: string) => void;
  slashMenuOpen: boolean;
  slashQuery: string | null;
  displayedSlashCommands: SlashCommand[];
  slashActiveIndex: number;
  setSlashActiveIndex: (index: number | ((index: number) => number)) => void;
  setSlashMenuOpen: (open: boolean) => void;
  getNextSlashIndex: (direction: "down" | "up" | "right" | "left") => number;
  applySlashCommand: (command: SlashCommand) => void;
  submitsSlashCommandOnEnter: (message: string, command: SlashCommand, isStreaming: boolean) => boolean;
  value: string;
  atMenuOpen: boolean;
  atQuery: unknown;
  atMatches: AtMatch[];
  atActiveIndex: number;
  setAtActiveIndex: (index: number | ((index: number) => number)) => void;
  setAtMenuOpen: (open: boolean) => void;
  cycleListIndex: (index: number, length: number, delta: number) => number;
  applyAtCompletion: (match: AtMatch) => void;
  onAbort?: () => void;
  onSteer?: (...args: never[]) => void;
  onFollowUp?: (...args: never[]) => void;
  sendQueued: (mode: "steer" | "followup") => void;
  handleSend: (...args: never[]) => void;
}

export function handleComposerKeyDown<SlashCommand, AtMatch>(
  e: ComposerKeyEvent,
  deps: ComposerKeyDownDeps<SlashCommand, AtMatch>,
): void {
  const nativeEvent = e.nativeEvent;
  const enterKey = e.key === "Enter" && !e.shiftKey;
  const sendShortcut = deps.isMobile || deps.enterSendMode === "ctrlEnter"
    ? enterKey && (e.ctrlKey || e.metaKey)
    : enterKey;
  // Popup menus and the IME guard take plain Enter in either send mode on a
  // desktop keyboard. Mobile keyboards insert a line break on Enter, so they
  // keep using the send shortcut there.
  const acceptShortcut = deps.isMobile ? sendShortcut : enterKey;
  const recentlyComposed = deps.now() - deps.lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
  const isComposing =
    deps.isComposingRef.current ||
    nativeEvent.isComposing ||
    nativeEvent.keyCode === 229;

  if (acceptShortcut && (isComposing || recentlyComposed)) {
    if (recentlyComposed) e.preventDefault();
    return;
  }

  if (deps.historyMenuOpen && !deps.extensionUiOpen && !isComposing) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      deps.setHistoryActiveIndex((i) => Math.min(Math.max(0, deps.inputHistory.length - 1), i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      deps.setHistoryActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      deps.setHistoryMenuOpen(false);
      return;
    }
    if ((e.key === "Tab" || acceptShortcut) && deps.inputHistory[deps.historyActiveIndex]) {
      e.preventDefault();
      deps.applyHistoryInput(deps.inputHistory[deps.historyActiveIndex]);
      return;
    }
  }

  if (deps.slashMenuOpen && deps.slashQuery !== null && !deps.extensionUiOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      deps.setSlashActiveIndex(deps.getNextSlashIndex("down"));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      deps.setSlashActiveIndex(deps.getNextSlashIndex("up"));
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      deps.setSlashActiveIndex(deps.getNextSlashIndex("right"));
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      deps.setSlashActiveIndex(deps.getNextSlashIndex("left"));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      deps.setSlashMenuOpen(false);
      return;
    }
    const selectedCommand = deps.displayedSlashCommands[deps.slashActiveIndex];
    if (e.key === "Tab" && selectedCommand) {
      e.preventDefault();
      deps.applySlashCommand(selectedCommand);
      return;
    }
    // A command that runs while a run streams takes Enter, as its menu row says.
    if (acceptShortcut && selectedCommand) {
      e.preventDefault();
      if (sendShortcut && deps.submitsSlashCommandOnEnter(deps.value, selectedCommand, deps.isStreaming)) {
        deps.setSlashMenuOpen(false);
        void deps.handleSend();
      } else {
        deps.applySlashCommand(selectedCommand);
      }
      return;
    }
  }

  // @ file menu — skip while composing so IME candidate navigation
  // (arrows/Enter/Tab) is never intercepted.
  if (deps.atMenuOpen && deps.atQuery !== null && !deps.extensionUiOpen && !isComposing) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      deps.setAtActiveIndex((i) => deps.cycleListIndex(i, deps.atMatches.length, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      deps.setAtActiveIndex((i) => deps.cycleListIndex(i, deps.atMatches.length, -1));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      deps.setAtMenuOpen(false);
      return;
    }
    if ((e.key === "Tab" || acceptShortcut) && deps.atMatches[deps.atActiveIndex]) {
      e.preventDefault();
      deps.applyAtCompletion(deps.atMatches[deps.atActiveIndex]);
      return;
    }
  }

  if (e.key === "ArrowUp" && !isComposing && !deps.isStreaming && deps.inputHistory.length > 0 && deps.value.trim().length === 0) {
    e.preventDefault();
    deps.setSlashMenuOpen(false);
    deps.setAtMenuOpen(false);
    deps.setHistoryActiveIndex(deps.inputHistory.length - 1);
    deps.setHistoryMenuOpen(true);
    return;
  }

  // Esc stops the agent when no slash/@/history menu or IME composition is active.
  if (e.key === "Escape" && !isComposing && deps.isStreaming && deps.onAbort) {
    e.preventDefault();
    deps.onAbort();
    return;
  }

  if (sendShortcut) {
    e.preventDefault();
    if (deps.isStreaming && (deps.onSteer || deps.onFollowUp)) {
      deps.sendQueued((e.altKey && deps.onFollowUp) || !deps.onSteer ? "followup" : "steer");
    } else {
      deps.handleSend();
    }
  }
}
