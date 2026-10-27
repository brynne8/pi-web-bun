"use client";

import { useMemo, useRef, useState } from "react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { usePrismLanguages } from "@/hooks/usePrismLanguages";
import { useI18n } from "@/hooks/useI18n";
import { getLanguage } from "@/lib/file-types";
import { getFileDirectory } from "@/lib/file-paths";
import { isDelimitedTablePath } from "@/lib/delimited-table";
import { resolveInitialWrapLines, type FileViewerDisplayMode } from "@/lib/file-viewer-state";
import {
  readSnapshotViewChoice,
  saveReadSnapshotViewChoice,
} from "@/lib/read-snapshot-view-state";
import { readSnapshotLineSpan, type ReadSnapshot } from "@/lib/read-snapshot";
import { DelimitedTable } from "./DelimitedTable";
import {
  DisplayModeSwitch,
  FILE_CODE_STYLE,
  FILE_LINE_NUMBER_STYLE,
  SOURCE_HIGHLIGHT_MAX_LINES,
  SourceCodeRenderer,
  WrapToggleButton,
  fileViewerDarkTheme,
} from "./FileViewer";
import { MarkdownBody } from "./MarkdownBody";

interface Props extends ReadSnapshot {
  /** The card this panel belongs to: it owns the Source/Preview and wrap choices. */
  toolCallId?: string;
  /** Following a link opens the live file: the snapshot itself is never re-read. */
  onOpenFile?: (filePath: string, page?: number) => void;
}

/**
 * The exact slice one `read` tool call returned, in a right-panel tab: not
 * the file, but what the model was shown, kept from the chat. A markdown
 * slice renders as markdown with Source one click away, a delimited one as
 * the file viewer's table numbered by the file's lines, everything else as
 * highlighted source wrapping by kind with its gutter from the read's offset.
 */
export function ReadSnapshotViewer({ filePath, content, offset, toolCallId, onOpenFile }: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  // DelimitedTable never scrolls itself: this box is the scroller its sticky
  // header and rows are measured against.
  const scrollRef = useRef<HTMLDivElement>(null);
  const language = getLanguage(filePath);
  const isMarkdown = language === "markdown";
  const firstLine = offset ?? 1;
  const savedChoice = readSnapshotViewChoice(toolCallId);
  const [displayMode, setDisplayMode] = useState<FileViewerDisplayMode>(() => (
    savedChoice?.displayMode === "source" || savedChoice?.displayMode === "preview"
      ? savedChoice.displayMode
      : "preview"
  ));
  const [wrapLines, setWrapLines] = useState(() => resolveInitialWrapLines(savedChoice, filePath));

  const updateDisplayMode = (mode: FileViewerDisplayMode) => {
    setDisplayMode(mode);
    saveReadSnapshotViewChoice(toolCallId, { displayMode: mode, wrapLines });
  };
  const toggleWrapLines = () => {
    setWrapLines((current) => {
      const next = !current;
      saveReadSnapshotViewChoice(toolCallId, { displayMode, wrapLines: next });
      return next;
    });
  };

  // The table renders nothing for text with no record in it, so a slice that
  // holds none (an empty or blank one) keeps the source view rather than an
  // empty panel.
  const hasRecords = content.trim() !== "";
  const isTable = isDelimitedTablePath(filePath) && hasRecords;
  const showPreview = isMarkdown && displayMode === "preview";
  const sliceSpan = readSnapshotLineSpan({ content, offset });
  // Past the file viewer's own limit the highlighter would rebuild an element per
  // token on every render, so a big slice goes the way a big file does: the same
  // plain, still numbered source, with one line saying why it is uncoloured.
  const lines = useMemo(() => content.split("\n"), [content]);
  const tooBigToHighlight = lines.length > SOURCE_HIGHLIGHT_MAX_LINES;
  // A read panel opens after the page does, so the Prism languages load then,
  // as the file viewer's do: the source shows untokenised until the chunk
  // arrives, and is coloured once it does.
  usePrismLanguages(!tooBigToHighlight && !isTable && !showPreview && language !== "text");

  const source = useMemo(
    () => (
      <SyntaxHighlighter
        className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
        language={language === "text" ? "plaintext" : language}
        style={isDark ? fileViewerDarkTheme : vs}
        showLineNumbers
        startingLineNumber={firstLine}
        lineNumberStyle={FILE_LINE_NUMBER_STYLE}
        customStyle={{
          margin: 0,
          padding: 0,
          border: 0,
          backgroundColor: "var(--bg)",
          ...FILE_CODE_STYLE,
          width: wrapLines ? "100%" : "max-content",
          minWidth: "100%",
          minHeight: "100%",
          overflow: "visible",
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
            overflowWrap: wrapLines ? "anywhere" : "normal",
          },
        }}
        renderer={(rendererProps) => (
          <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} firstLine={firstLine} />
        )}
        wrapLongLines={wrapLines}
      >
        {content}
      </SyntaxHighlighter>
    ),
    [content, firstLine, isDark, language, wrapLines],
  );

  const plainSource = useMemo(
    () => (tooBigToHighlight
      ? lines.map((line, index) => (
        <span
          className="file-source-line"
          data-line-number={firstLine + index}
          key={`plain-source-line-${firstLine + index}`}
          style={{ display: "flex", minWidth: "100%" }}
        >
          <span aria-hidden="true" style={FILE_LINE_NUMBER_STYLE}>{firstLine + index}</span>
          <span
            className="file-source-line-content"
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflowWrap: wrapLines ? "anywhere" : "normal",
              whiteSpace: wrapLines ? "pre-wrap" : "pre",
            }}
          >
            {line}
          </span>
        </span>
      ))
      : null),
    [firstLine, lines, tooBigToHighlight, wrapLines],
  );

  // The controls sit above the scroller so they stay reachable on a long slice;
  // the table has no lines to wrap, so its panel keeps no key for them.
  const header = isTable ? null : (
    <div
      className="file-viewer-controls"
      style={{
        justifyContent: "flex-end",
        padding: "4px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}
    >
      {isMarkdown && (
        <DisplayModeSwitch
          modes={["source", "preview"]}
          active={displayMode}
          onSelect={updateDisplayMode}
        />
      )}
      {!showPreview && <WrapToggleButton wrapLines={wrapLines} onToggle={toggleWrapLines} />}
    </div>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {header}
      <div ref={scrollRef} style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", background: "var(--bg)" }}>
        {isTable ? (
          <>
            {firstLine > 1 && (
              // A slice cut inside a quoted multi-line field cannot be re-joined by
              // any parser: the rows it yields start where the slice does. Say so,
              // rather than let a merged row look like a bug in the table.
              <p style={{ margin: 0, padding: "5px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                {t("readPanel.sliceHint", { from: sliceSpan.from, to: sliceSpan.to, firstLine })}
              </p>
            )}
            <DelimitedTable
              content={content}
              filePath={filePath}
              complete
              scrollRef={scrollRef}
              firstLine={firstLine}
            />
          </>
        ) : showPreview ? (
          <div className="markdown-file-preview" style={{ padding: "24px 32px" }}>
            <MarkdownBody cwd={getFileDirectory(filePath)} onOpenFile={onOpenFile}>{content}</MarkdownBody>
          </div>
        ) : (
          <>
            {tooBigToHighlight && (
              <p style={{ margin: 0, padding: "5px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
                {t("readPanel.plainSourceHint", { max: SOURCE_HIGHLIGHT_MAX_LINES })}
              </p>
            )}
            {tooBigToHighlight ? (
              <div
                className="file-source-view is-lightweight"
                style={{
                  width: wrapLines ? "100%" : "max-content",
                  minWidth: "100%",
                  minHeight: "100%",
                  background: "var(--bg)",
                  ...FILE_CODE_STYLE,
                }}
              >
                {plainSource}
              </div>
            ) : (
              source
            )}
          </>
        )}
      </div>
    </div>
  );
}
