// The composer's file picker: picked files go to the chat's attach handler, or attach as
// images when the page has none (#1101).

/** The input a file pick happened on. */
export interface ComposerFilePickTarget {
  files: ArrayLike<File> | null;
  value: string;
}

export interface ComposerFilePickDeps {
  onAttachFiles?: (files: File[]) => void;
  processImageFiles: (files: File[]) => void;
}

export function handleComposerFilePick(e: { target: ComposerFilePickTarget }, deps: ComposerFilePickDeps): void {
  const files = Array.from(e.target.files ?? []);
  // Clearing the value lets the same file be picked again.
  e.target.value = "";
  if (deps.onAttachFiles) deps.onAttachFiles(files);
  else deps.processImageFiles(files);
}
