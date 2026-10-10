"use client";

import { useMemo, useRef } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { getLanguage } from "@/lib/file-types";
import { getFileDirectory } from "@/lib/file-paths";
import { isDelimitedTablePath } from "@/lib/delimited-table";
import { readSnapshotLineSpan, type ReadSnapshot } from "@/lib/read-snapshot";
import { DelimitedTable } from "./DelimitedTable";
import { FILE_CODE_STYLE, FILE_LINE_NUMBER_STYLE, SOURCE_HIGHLIGHT_MAX_LINES, fileViewerDarkTheme } from "./FileViewer";
import { MarkdownBody } from "./MarkdownBody";

interface Props extends ReadSnapshot {
  /** Following a link opens the live file: the snapshot itself is never re-read. */
  onOpenFile?: (filePath: string, page?: number) => void;
}

/**
 * The exact slice one `read` tool call returned, in a right-panel tab.
 *
 * Not the file: what the model was shown, kept from the chat. A markdown slice
 * renders as markdown, a delimited one as the same table the file viewer uses
 * (numbered by the file's lines, not the slice's), everything else as
 * highlighted source whose gutter continues from the read's offset.
 */
export function ReadSnapshotViewer({ filePath, content, offset, onOpenFile }: Props) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  // DelimitedTable never scrolls itself: this box is the scroller its sticky
  // header and rows are measured against.
  const scrollRef = useRef<HTMLDivElement>(null);
  const language = getLanguage(filePath);
  const firstLine = offset ?? 1;
  // The table renders nothing for text with no record in it, so a slice that
  // holds none (an empty or blank one) keeps the source view rather than an
  // empty panel.
  const hasRecords = content.trim() !== "";
  // Past the file viewer's own limit the highlighter would rebuild an element per
  // token on every render, so a big slice goes the way a big file does: the same
  // plain, still numbered source, with one line saying why it is uncoloured.
  const lines = useMemo(() => content.split("\n"), [content]);
  const tooBigToHighlight = lines.length > SOURCE_HIGHLIGHT_MAX_LINES;

  const source = useMemo(
    () => (
      <SyntaxHighlighter
        className="file-source-view"
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
          width: "max-content",
          minWidth: "100%",
          minHeight: "100%",
          overflow: "visible",
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono)",
            fontWeight: "var(--font-mono-weight)",
          },
        }}
      >
        {content}
      </SyntaxHighlighter>
    ),
    [content, firstLine, isDark, language],
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
          <span className="file-source-line-content" style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "pre" }}>
            {line}
          </span>
        </span>
      ))
      : null),
    [firstLine, lines, tooBigToHighlight],
  );

  if (isDelimitedTablePath(filePath) && hasRecords) {
    const { from, to } = readSnapshotLineSpan({ content, offset });
    return (
      <div ref={scrollRef} style={{ height: "100%", overflow: "auto", background: "var(--bg)" }}>
        {firstLine > 1 && (
          // A slice cut inside a quoted multi-line field cannot be re-joined by
          // any parser: the rows it yields start where the slice does. Say so,
          // rather than let a merged row look like a bug in the table.
          <p style={{ margin: 0, padding: "5px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
            {t("readPanel.sliceHint", { from, to, firstLine })}
          </p>
        )}
        <DelimitedTable
          content={content}
          filePath={filePath}
          complete
          scrollRef={scrollRef}
          firstLine={firstLine}
        />
      </div>
    );
  }

  if (language === "markdown") {
    return (
      <div style={{ height: "100%", overflow: "auto", background: "var(--bg)" }}>
        <div className="markdown-file-preview" style={{ padding: "24px 32px" }}>
          <MarkdownBody cwd={getFileDirectory(filePath)} onOpenFile={onOpenFile}>{content}</MarkdownBody>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflow: "auto", background: "var(--bg)" }}>
      {tooBigToHighlight && (
        <p style={{ margin: 0, padding: "5px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.5 }}>
          {t("readPanel.plainSourceHint", { max: SOURCE_HIGHLIGHT_MAX_LINES })}
        </p>
      )}
      {tooBigToHighlight ? (
        <div
          className="file-source-view is-lightweight"
          style={{
            width: "max-content",
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
    </div>
  );
}
