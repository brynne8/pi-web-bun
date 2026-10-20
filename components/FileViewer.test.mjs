import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\\.(csv|tsv)$/i.test(path);
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
      const FILE_LINE_NUMBER_STYLE = {};
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  // A CSV/TSV table previews a loaded prefix too; markdown waits for the whole file.
  assert.equal(render({ ...large, truncated: true }, "preview", false, false, false, "/tmp/data.csv"), null);
  assert.equal(render({ ...large, language: "markdown", truncated: true }, "preview").length, 1_001);
  // A partly loaded HTML file previews too: the preview fetches it whole.
  assert.equal(render({ ...large, language: "html", truncated: true, size: 900 * 1024 }, "preview"), null);
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("the diff view wraps when the viewer wraps", () => {
  const diffView = source.slice(source.indexOf("function DiffView"), source.indexOf("function ImageViewer"));
  assert.notEqual(source.indexOf("function DiffView"), -1);

  // Wrapped: the box stops being the widest line's width and the row's text column
  // gives way instead of pushing a horizontal scrollbar.
  assert.match(diffView, /width: wrapLines \? "100%" : "max-content"/);
  assert.match(diffView, /whiteSpace: wrapLines \? "pre-wrap" : "pre"/);
  assert.match(diffView, /overflowWrap: wrapLines \? "anywhere" : "normal"/);
  assert.match(diffView, /flexShrink: wrapLines \? 1 : 0/);
  // Unwrapped stays exactly as before: one line per row, sideways scroll.
  assert.match(diffView, /padding: "0 6px",[\s\S]{0,160}flexShrink: 0/);
  assert.match(source, /<DiffView patch=\{gitDiff\.patch!\} wrapLines=\{wrapLines\} \/>/);

  // The wrap control is offered for the diff as well as the source, never for a
  // rendered preview (markdown, HTML, table), where there are no lines to wrap.
  assert.match(
    source,
    /\{\(effectiveDisplayMode === "source" \|\| effectiveDisplayMode === "diff"\) && \(\s*<WrapToggleButton wrapLines=\{wrapLines\} onToggle=\{toggleWrapLines\} \/>/,
  );
  // Both header controls are the shared components, so this panel and the read
  // snapshot's cannot drift into two different buttons.
  assert.match(source, /<DisplayModeSwitch\n\s*modes=\{displayModes\}/);
  assert.match(source, /export function DisplayModeSwitch/);
  assert.match(source, /export function WrapToggleButton/);
  assert.match(source, /export function SourceCodeRenderer/);
});

test("the source gutter stays pinned and shares the code line's height", () => {
  const codeBlock = source.slice(source.indexOf("export const FILE_CODE_STYLE"), source.indexOf("export const fileViewerDarkTheme"));
  const gutterBlock = source.slice(source.indexOf("export const FILE_LINE_NUMBER_STYLE"), source.indexOf("type SourceCodeRendererProps"));
  assert.notEqual(source.indexOf("export const FILE_LINE_NUMBER_STYLE"), -1);
  assert.notEqual(source.indexOf("type SourceCodeRendererProps"), -1);

  // The gutter is a fixed column: it sticks to the scroller's left edge (that box
  // is `overflow: auto` in both viewers) instead of sliding away with the text.
  assert.match(gutterBlock, /position: "sticky"/);
  assert.match(gutterBlock, /left: 0/);
  // Sticky needs room to travel, so every row spans the widest line.
  assert.match(source, /className="file-source-line"[\s\S]{0,160}minWidth: "100%"/);

  // The gutter repeats its height in px, so a code-font change without it puts
  // the numbers off the line boxes they belong to.
  const fontSize = Number(codeBlock.match(/fontSize: (\d+)/)?.[1]);
  const lineHeightFactor = Number(codeBlock.match(/lineHeight: ([\d.]+)/)?.[1]);
  const gutterLineHeight = Number(gutterBlock.match(/lineHeight: "([\d.]+)px"/)?.[1]);
  assert.ok(Number.isFinite(fontSize) && Number.isFinite(lineHeightFactor), "code style sets a numeric font size and factor");
  assert.equal(gutterLineHeight, Number((fontSize * lineHeightFactor).toFixed(1)));
});

test("markdown preview keeps app links and opens web and app links in a new tab (#1108)", () => {
  assert.match(source, /urlTransform=\{onOpenFile \? markdownUrlTransform : markdownAppUrlTransform\}/);
  assert.match(
    source,
    /return isExternalMarkdownHref\(href\)\s*\? <a href=\{href\} \{\.\.\.props\} target="_blank" rel="noopener noreferrer">\{children\}<\/a>\s*: <a href=\{href\} \{\.\.\.props\} onClick=\{jumpToMarkdownFragment\}>\{children\}<\/a>;/,
  );
});

test("partly loaded HTML previews up to the HTML cap; partly loaded markdown does not", () => {
  const start = source.indexOf("  const hasPreview = ");
  const statement = source.slice(start, source.indexOf(";\n", start) + 1);
  const hasPreview = new Function("data", "isHtml", "isMarkdown", "isDelimitedTable", "HTML_PREVIEW_MAX_BYTES", `${statement}\nreturn hasPreview;`);
  const cap = 10 * 1024 * 1024;
  const partial = { truncated: true, size: 900 * 1024 };

  assert.equal(hasPreview(partial, true, false, false, cap), true);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, true, false, false, cap), false);
  assert.equal(hasPreview({ truncated: false, size: cap + 1 }, true, false, false, cap), true);
  assert.equal(hasPreview(partial, false, true, false, cap), false);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, false, false, true, cap), true);
});

test("the line-number gutter is pinned in every view", () => {
  // Evaluate the module's own style constants (the numbers in the highlighted,
  // plain and diff views all come from these), the highlighted and lightweight
  // source elements and the Diff view's rows, instead of matching the
  // component's text.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = (...names) => {
    const statements = names.map((name) => {
      const statement = file.statements.find((node) =>
        ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === name,
        ),
      );
      assert.ok(statement, `${name} is declared in the module`);
      // These are exported (components/ReadSnapshotViewer.tsx imports them), and an
      // `export` in a function body is a syntax error.
      return statement.getText(file).replace(/^export /, "");
    });
    const { outputText } = ts.transpileModule(`${statements.join("\n")}\nreturn [${names.join(", ")}];`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    return new Function(outputText)();
  };
  const [codeStyle, gutterStyle, maxRows] = constants("FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "SOURCE_HIGHLIGHT_MAX_LINES");

  // Build the source views without mounting the file-fetching component, with
  // the real gutter styles in place.
  const calculations = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer").body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines", "prismReady", "highlightedSource"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\.(csv|tsv)$/i.test(path);
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
      const FILE_LINE_NUMBER_STYLE = gutterStyle;
      // Stand-ins for what the highlighted element only passes on.
      const [usePrismLanguages, SyntaxHighlighter, SourceCodeRenderer, isDark, vs, fileViewerDarkTheme, FILE_CODE_STYLE] = [() => true, "pre", "span", false, {}, {}, {}];
      ${calculations}
      return { lightweightSourceLines, highlightedSource };
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", "gutterStyle", outputText)(React, (calculate) => calculate(), gutterStyle);
  const { lightweightSourceLines: rows, highlightedSource } = render({ content: "line\n".repeat(1_000), language: "text" }, "source");
  const numberStyle = rows[0].props.children[0].props.style;
  // The Diff view's first row number, with every row an added line.
  const diffView = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "DiffView");
  const { outputText: diffOutput } = ts.transpileModule(`return ${diffView.getText(file)}`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } });
  const diffNumberStyle = (rowCount) => {
    const added = Array.from({ length: rowCount }, (_, index) => ({ type: "added", text: "line", oldLineNo: null, newLineNo: index + 1 }));
    const DiffView = new Function("React", "useI18n", "diffLines", "SOURCE_HIGHLIGHT_MAX_LINES", "FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", diffOutput)(
      React, () => ({ t: (key) => key }), () => added, maxRows, codeStyle, gutterStyle,
    );
    return DiffView({ patch: "" }).props.children[0].props.children[0].props.children[0].props.style;
  };

  // The pinned gutter is the same column, pinned to the left edge of the
  // viewer's `overflow: auto` content box above the tokens that slide behind it,
  // and it is that one column in every view.
  assert.equal(gutterStyle.position, "sticky");
  assert.equal(gutterStyle.left, 0);
  assert.ok(gutterStyle.zIndex >= 1, "the pinned gutter must stack above the scrolling text");
  assert.deepEqual(highlightedSource.props.lineNumberStyle, gutterStyle);
  assert.equal(diffNumberStyle(maxRows), gutterStyle);
  assert.equal(diffNumberStyle(maxRows + 1), gutterStyle);
  assert.equal(numberStyle, gutterStyle);

  // The gutter repeats the code line's height in px, so a code-font change
  // without it puts the numbers off the line boxes they belong to.
  assert.equal(parseFloat(numberStyle.lineHeight), Number((codeStyle.fontSize * codeStyle.lineHeight).toFixed(1)));
});
