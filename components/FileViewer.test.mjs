import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("the source view renders and highlights a window, never every line", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["isBinary", "isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "showingSource"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\\.(csv|tsv)$/i.test(path);
      const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
      ${calculations}
      return showingSource;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const showingSource = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(50_000), language: "text" };

  // Only the line list is windowed; a diff and a rendered preview draw themselves.
  assert.equal(showingSource(large, "source"), true);
  assert.equal(showingSource(large, "diff", true), false);
  assert.equal(showingSource(large, "diff", false), true);
  for (const language of ["html", "markdown"]) {
    assert.equal(showingSource({ ...large, language }, "preview"), false);
  }
  assert.equal(showingSource({ ...large, truncated: true }, "preview", false, false, "/tmp/data.csv"), false);

  // The window is chosen by `highlightBlocks()` from the total line count and the
  // rendered range; nothing maps over every source line any more.
  assert.match(source, /highlightBlocks\(sourceLines\.length, sourceVirtual\.range\.start, sourceVirtual\.range\.end\)/);
  assert.match(source, /sourceBlocks\.map\(\(block\) => \(/);
  assert.doesNotMatch(source, /sourceLines\.map\(/);
  // A block tokenizes its context but renders only its own lines.
  assert.match(source, /rows=\{rendererProps\.rows\.slice\(contextLines\)\}/);
  assert.match(source, /startingLineNumber=\{start \+ 1\}/);
  // Find searches every loaded line, not the rendered window.
  assert.match(source, /findSourceMatches\(sourceLines, findQuery, findCaseSensitive\)/);
  assert.match(source, /sourceVirtual\.scrollToLine|scrollToSourceLine\(activeMatch\.line\)/);
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

test("the code column is the real sideways scroller, beside the numbers", async () => {
  // A scroller's horizontal scrollbar spans its whole box, so it would run under
  // the line numbers. The source view instead makes the code its own scroller and
  // keeps the numbers in a column beside it: no fake bar, no hidden scrollbar.
  const width = source.match(/export const FILE_LINE_NUMBER_WIDTH = (\d+);/)?.[1];
  assert.equal(Number(width), 48);
  assert.match(source, /width: FILE_LINE_NUMBER_WIDTH,\s*minWidth: FILE_LINE_NUMBER_WIDTH/);

  // The gutter renders one absolutely positioned cell per rendered line, at that
  // line's own offset and height, so a wrapped line's number stays on its row.
  assert.match(source, /export const FILE_GUTTER_NUMBER_STYLE/);
  assert.match(source, /height: Math\.max\(0, \(offsets\[line \+ 1\] \?\? 0\) - \(offsets\[line\] \?\? 0\)\),/);
  assert.match(source, /export const FILE_LINE_NUMBER_STYLE/);

  // The column pair is sticky at the top of the scrollable space, so its height
  // is the scroller's visible one and it never scrolls away.
  assert.match(source, /position: "sticky",\s*top: 0,\s*width: "100%",\s*height: Math\.max\(1, sourceVirtual\.viewportHeight\),/);
  // Both layers ride the scroll with a transform, written straight to the nodes
  // so a scroll lands in the same frame and React never resets it.
  assert.match(source, /applySourceScroll\(scrollTop, codeInnerRef\.current, gutterInnerRef\.current\)/);
  assert.match(source, /applySourceScroll\(viewerStateRef\.current\.scrollTop, codeInnerRef\.current, gutterInnerRef\.current\)/);
  assert.match(source, /if \(code\) code\.style\.transform = transform;/);
  assert.match(source, /if \(gutter\) gutter\.style\.transform = transform;/);
  // Neither layer carries the transform in its style prop.
  assert.doesNotMatch(source, /transform: `translateY/);

  // The code column is the scroller: sideways in it, never in the outer box.
  assert.match(source, /overflowX: "auto",\s*overflowY: "hidden",/);
  assert.match(source, /flex: "1 1 auto",\s*minWidth: 0,/);
  // Rows carry no inline number cell any more; the column owns them.
  assert.match(source, /showLineNumbers=\{false\}/);
  assert.doesNotMatch(source, /lineNumberStyle=\{\{\s*\.\.\.FILE_LINE_NUMBER_STYLE/);
  // No fake scrollbar, no hidden native one, no per-browser escape hatch.
  assert.doesNotMatch(source, /file-hscroll|file-viewer-content-gutter/);

  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /file-hscroll|file-viewer-content-gutter/);
});

test("the line-number gutter is pinned in every view", () => {
  // Evaluate the module's own style constants (the numbers in the highlighted,
  // diff and snapshot views all come from these), then check the Diff view's
  // rows and the source block's line-number style against them.
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
  const [gutterWidth, codeStyle, gutterStyle, maxRows] = constants("FILE_LINE_NUMBER_WIDTH", "FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "SOURCE_HIGHLIGHT_MAX_LINES");
  assert.equal(gutterWidth, 48);

  // The diff view still numbers its rows inline, so its gutter is the same
  // column the source view used to draw (the source view moved it out; see the
  // code-column test above).

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

  // The pinned gutter is the same column in every view: pinned to the left edge
  // of the viewer's `overflow: auto` content box, above the tokens sliding behind.
  assert.equal(gutterStyle.position, "sticky");
  assert.equal(gutterStyle.left, 0);
  assert.ok(gutterStyle.zIndex >= 1, "the pinned gutter must stack above the scrolling text");
  assert.equal(diffNumberStyle(maxRows), gutterStyle);
  assert.equal(diffNumberStyle(maxRows + 1), gutterStyle);

  // The gutter repeats the code line's height in px, so a code-font change
  // without it puts the numbers off the line boxes they belong to.
  assert.equal(parseFloat(gutterStyle.lineHeight), Number((codeStyle.fontSize * codeStyle.lineHeight).toFixed(1)));
});
