import { isReadToolName } from "@/lib/tool-names";

/**
 * The exact slice one `read` tool call returned.
 *
 * A snapshot, not a path: the panel shows what the model was shown. The file
 * behind it may since have changed, moved or gone, and re-fetching would answer
 * a question nobody asked. Nothing here is re-read, re-parsed from disk or
 * watched for changes.
 */
export interface ReadSnapshot {
  filePath: string;
  content: string;
  /** The file line the slice starts on; absent when the read started at the top. */
  offset?: number;
}

export interface ReadSnapshotSource {
  toolName: string;
  /** The call's parsed input; streamed input is incomplete and never used. */
  input?: Record<string, unknown> | null;
  /** The call's whole text result, or null when it has none — no result, or one of images only. */
  resultText: string | null;
  isError?: boolean;
  /** The result carried an image: the card shows it, there is no text to view. */
  hasImages?: boolean;
  /** The input is still streaming: incomplete JSON, and no result of its own yet. */
  streamingInput?: boolean;
}

/**
 * pi's own continuation notice, appended after the slice with a blank line
 * ("[Showing lines 12-40 of 90. …]", "[37 more lines in file. …]"). It is
 * addressed to the model, and a table row would carry it as a field. The
 * "to continue.]" tail is part of the match: a file whose own last line looks
 * like a notice is content, and stays.
 */
const TRAILING_NOTE = /\n*\[(?:\d+ more lines in file|Showing lines)[^\]]*to continue\.\]\s*$/;

/**
 * The panel view of a read call, or null when the card keeps its own body: not
 * a read, no result, a failed call, a result of images, input still streaming,
 * or a slice with nothing in it.
 */
export function readSnapshotOfCall(source: ReadSnapshotSource): ReadSnapshot | null {
  if (source.streamingInput === true || source.isError === true || source.hasImages === true) return null;
  if (!isReadToolName(source.toolName)) return null;
  const text = source.resultText;
  if (text === null) return null;
  const input = source.input;
  if (!input || typeof input !== "object") return null;
  // pi's `read` takes `path`; MCP servers that expose the same tool spell it `file_path`.
  const filePath = typeof input.path === "string"
    ? input.path
    : typeof input.file_path === "string" ? input.file_path : "";
  if (filePath.trim() === "") return null;
  // A card re-renders with its message, and a read's result can be 256 KB: the
  // anchored test costs a scan, so the copy is made only when there is a note.
  const content = TRAILING_NOTE.test(text) ? text.replace(TRAILING_NOTE, "") : text;
  // An empty file read as nothing: the card says so, an empty tab says nothing.
  if (content.trim() === "") return null;
  const rawOffset = typeof input.offset === "number" ? input.offset : undefined;
  return rawOffset !== undefined && Number.isSafeInteger(rawOffset) && rawOffset > 1
    ? { filePath, content, offset: rawOffset }
    : { filePath, content };
}

/** How many file lines a snapshot covers, for the note about a parsed slice. */
export function readSnapshotLineSpan(snapshot: { content: string; offset?: number }): { from: number; to: number } {
  const from = snapshot.offset ?? 1;
  let lines = 1;
  let index = snapshot.content.indexOf("\n");
  while (index !== -1) {
    lines += 1;
    index = snapshot.content.indexOf("\n", index + 1);
  }
  // A trailing line break is the end of the last line, not an extra line.
  if (snapshot.content.endsWith("\n")) lines -= 1;
  return { from, to: from + Math.max(lines, 1) - 1 };
}
