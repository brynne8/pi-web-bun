import { holdStoredDraft as holdStoredDraftInStore } from "./draft-store.ts";

// The composer's `/command` run: what it does while it runs, and how the editor gets its
// focus back once the fieldset is enabled again. Kept out of the component so a test can
// drive it against a stand-in document, as the browser's own is here.

/** The element a focus restore hands focus to. */
export type BuiltinCommandFocusTarget = HTMLElement;

/** The document a focus restore reads and listens on. */
export type BuiltinCommandDocument = Document;

/** What a built-in command answered with: whether it took the message, and its refusal. */
export interface BuiltinCommandResult {
  handled: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface RunBuiltinCommandDeps {
  document: BuiltinCommandDocument;
  /** The composer's editor, which the run remembered the focus of. */
  textarea: BuiltinCommandFocusTarget | null;
  attachedImages: unknown[];
  onBuiltinCommand?: (msg: string) => Promise<BuiltinCommandResult> | BuiltinCommandResult;
  valueRef: { current: string };
  attachedImagesRef: { current: unknown[] };
  focusRef: { current: BuiltinCommandFocusTarget | null };
  pendingRef: { current: boolean };
  setPending: (pending: boolean) => void;
  canClearBuiltinCommandInput: (message: string, imageCount: number, submittedMessage: string) => boolean;
  clearInput: () => void;
  /** The composer's draft key: while the command runs, its text is held out of stored drafts. */
  draftKeyRef?: { current: string | null | undefined };
  /** The hold itself; the store's by default, a test's stand-in here. */
  holdStoredDraft?: (key: string) => () => void;
}

/**
 * A `/command` typed in the composer. The fieldset stays disabled until it settles, so
 * the editor's focus is remembered here and given back by `restoreBuiltinCommandFocus()`
 * once it is enabled again. A command that took the message clears the composer, unless
 * an image came with it or the text moved on since.
 */
export async function runBuiltinCommand(msg: string, deps: RunBuiltinCommandDeps): Promise<boolean> {
  const {
    document, textarea, attachedImages, onBuiltinCommand,
    valueRef, attachedImagesRef, focusRef, pendingRef, setPending,
    canClearBuiltinCommandInput, clearInput, draftKeyRef,
    holdStoredDraft = holdStoredDraftInStore,
  } = deps;
  if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
  if (pendingRef.current) return true;
  focusRef.current = document.activeElement === textarea ? textarea : null;
  pendingRef.current = true;
  setPending(true);
  // The command stays in the composer while it runs, but it was already issued: a
  // reload meanwhile must not bring it back to be run again.
  const releaseStoredDraft = draftKeyRef?.current ? holdStoredDraft(draftKeyRef.current) : null;
  try {
    const result = await onBuiltinCommand(msg);
    if (!result.handled) return false;
    if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
    return true;
  } finally {
    releaseStoredDraft?.();
    pendingRef.current = false;
    setPending(false);
  }
}

/**
 * While the fieldset is disabled: a pointer press anywhere but the editor the focus is
 * remembered for says the user moved on, so the restore is dropped.
 */
export function cancelBuiltinCommandFocusOnPointerDown(
  document: BuiltinCommandDocument,
  focusRef: { current: BuiltinCommandFocusTarget | null },
): () => void {
  const cancelRestore = (event: { target: unknown }) => {
    if (event.target !== focusRef.current) focusRef.current = null;
  };
  document.addEventListener("pointerdown", cancelRestore, true);
  return () => document.removeEventListener("pointerdown", cancelRestore, true);
}

/**
 * Once the fieldset is enabled again: give the editor its focus back. Disabling it
 * blurred the editor, so the browser reports `body` as the active element until the
 * enabling commit; anything that moved the focus in the meantime — the command, the
 * user, a modal — leaves it where it is.
 */
export function restoreBuiltinCommandFocus(
  document: BuiltinCommandDocument,
  focusRef: { current: BuiltinCommandFocusTarget | null },
): void {
  const textarea = focusRef.current;
  focusRef.current = null;
  if (textarea?.isConnected && document.activeElement === document.body
    && !document.querySelector('[aria-modal="true"]')) {
    textarea.focus({ preventScroll: true });
  }
}
