export type FileViewerDisplayMode = "source" | "preview" | "diff";

export interface FileViewerState {
  displayMode: FileViewerDisplayMode;
  // Undefined means the reader never chose: the file's own kind decides (see
  // wrapsByDefault). A pressed toggle writes a boolean, and that wins forever
  // after, whatever the extension says.
  wrapLines?: boolean;
  scrollTop: number;
  scrollLeft: number;
}

export function resolveInitialFileDisplayMode(
  initialState?: FileViewerState,
  initialDisplayMode?: FileViewerDisplayMode,
): FileViewerDisplayMode {
  return initialState?.displayMode ?? initialDisplayMode ?? "source";
}

// Prose wraps: a long line is the same sentence going on, and a horizontal
// scrollbar only hides the rest of the paragraph. Code keeps one line per row
// and scrolls sideways, because indentation and column alignment are the reading
// cue. `.txt` is here for holding prose more than structure; `.log` is not:
// a log line is a column, and wrapping puts the next line's timestamp where its message was.
const PROSE_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd", "rst", "adoc", "txt"]);

export function wrapsByDefault(filePath?: string): boolean {
  if (!filePath) return false;
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const ext = base.toLowerCase().split(".").pop() ?? "";
  return PROSE_EXTENSIONS.has(ext);
}

export function resolveInitialWrapLines(
  initialState?: { wrapLines?: boolean },
  filePath?: string,
): boolean {
  return initialState?.wrapLines ?? wrapsByDefault(filePath);
}
