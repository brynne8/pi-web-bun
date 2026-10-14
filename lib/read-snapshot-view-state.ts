import type { FileViewerDisplayMode } from "./file-viewer-state";

/**
 * What one read card's panel was last showing: Source or Preview, wrapped or
 * not. The panel unmounts when another tab comes forward, so without this the
 * choices made there would reset on every tab switch — the file viewer keeps
 * the same two facts on its tab, and a snapshot tab has no tab state of its own.
 */
export interface ReadSnapshotViewChoice {
  displayMode: FileViewerDisplayMode;
  /** Undefined means never chosen, so the file's kind still decides. */
  wrapLines?: boolean;
}

// Page memory, like the file tree's open folders: a handful of panels are open
// in a browsing session, and a reload starts clean.
const MAX_KEEP = 20;
const choices = new Map<string, ReadSnapshotViewChoice>();

export function readSnapshotViewChoice(toolCallId?: string): ReadSnapshotViewChoice | undefined {
  if (!toolCallId) return undefined;
  const saved = choices.get(toolCallId);
  if (!saved) return undefined;
  // Touch it: the entry left longest ago is the first one dropped.
  choices.delete(toolCallId);
  choices.set(toolCallId, saved);
  return saved;
}

export function saveReadSnapshotViewChoice(toolCallId: string | undefined, choice: ReadSnapshotViewChoice): void {
  if (!toolCallId) return;
  choices.delete(toolCallId);
  choices.set(toolCallId, choice);
  if (choices.size > MAX_KEEP) {
    const oldest = choices.keys().next();
    if (!oldest.done) choices.delete(oldest.value);
  }
}

/** Test-only: the module holds one Map for the whole process. */
export function clearReadSnapshotViewChoices(): void {
  choices.clear();
}
