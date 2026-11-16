// What the file viewer shows for one file: its source lines, a diff, or a rendered
// preview. Kept out of the component so a test can drive every combination of a file's
// kind, what is loaded of it, and the mode the reader picked.

export const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

/** The file the viewer has, as its read answered it. */
export interface FileViewContent {
  content?: string;
  language?: string;
  binary?: boolean;
  truncated?: boolean;
  size?: number;
}

export interface FileDisplayInput {
  filePath: string;
  data: FileViewContent | null;
  displayMode: "source" | "diff" | "preview";
  hasGitDiff: boolean;
  isDeletedDiff: boolean;
  isDelimitedTablePath: (path: string) => boolean;
}

export interface FileDisplayDecision {
  isBinary: boolean;
  isDelimitedTable: boolean;
  viewerContent: string;
  sourceLines: string[];
  language: string;
  isHtml: boolean;
  isMarkdown: boolean;
  hasPreview: boolean;
  effectiveDisplayMode: FileDisplayInput["displayMode"];
  /** Only what is drawn as source lines windows its line list. */
  showingSource: boolean;
  showLoadMore: boolean;
}

/**
 * Which of the three views a file takes. A table shows a loaded prefix too, without
 * its cut last record; an HTML preview fetches the whole file up to
 * `HTML_PREVIEW_MAX_BYTES`, so a partly loaded HTML file previews whole and its
 * "Load more" belongs to the source view instead.
 */
export function decideFileDisplay(input: FileDisplayInput): FileDisplayDecision {
  const isBinary = input.data?.binary === true;
  const isDelimitedTable = !isBinary && input.isDelimitedTablePath(input.filePath);
  const viewerContent = input.data?.content ?? "";
  const sourceLines = viewerContent.split("\n");
  const language = input.data?.language ?? "text";
  const isHtml = !isBinary && language === "html";
  const isMarkdown = !isBinary && language === "markdown";
  const hasPreview = isDelimitedTable || (isHtml
    ? !!input.data && (!input.data.truncated || (input.data.size ?? 0) <= HTML_PREVIEW_MAX_BYTES)
    : isMarkdown && !input.data?.truncated);
  const effectiveDisplayMode = input.isDeletedDiff ? "diff" : input.displayMode;
  const showingSource = !(effectiveDisplayMode === "diff" && input.hasGitDiff)
    && !(effectiveDisplayMode === "preview" && hasPreview);
  const showLoadMore = !!input.data?.truncated && !(isHtml && effectiveDisplayMode === "preview");
  return {
    isBinary, isDelimitedTable, viewerContent, sourceLines, language,
    isHtml, isMarkdown, hasPreview, effectiveDisplayMode, showingSource, showLoadMore,
  };
}
