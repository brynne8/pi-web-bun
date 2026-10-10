import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ReadSnapshotViewer } = await jiti.import("./ReadSnapshotViewer.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
// The size limit is the file viewer's own: a test with its own number would drift
// from the one the component reads.
const { SOURCE_HIGHLIGHT_MAX_LINES } = await jiti.import("./FileViewer.tsx");

const viewer = await readFile(new URL("./ReadSnapshotViewer.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const messageView = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const tabBar = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");

function render(props) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ReadSnapshotViewer, props)),
  );
}

test("markdown renders as markdown, and never as a numbered source view", () => {
  const html = render({ filePath: "/tmp/notes.md", content: "# Title\n\nsome **text**\n" });
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>text<\/strong>/);
  assert.doesNotMatch(html, /react-syntax-highlighter-line-number/);
});

test("source keeps the file's line numbers, continuing from the read's offset", () => {
  const numbers = (html) => [...html.matchAll(/line-number[^>]*>([^<]*)</g)].map((match) => match[1]);
  assert.deepEqual(numbers(render({ filePath: "/tmp/a.ts", content: "const a = 1;\nconst b = 2;" })), ["1", "2"]);
  assert.deepEqual(numbers(render({ filePath: "/tmp/a.ts", content: "const a = 1;\nconst b = 2;", offset: 40 })), ["40", "41"]);
});

test("past the file viewer's limit a big slice is plain text, still numbered, and says so", () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `const line${i} = ${i};`).join("\n");

  // The limit reads "more than", exactly as FileViewer's own check, so a slice of
  // the largest allowed size still gets its colours.
  const atLimit = render({ filePath: "/tmp/big.ts", content: body(SOURCE_HIGHLIGHT_MAX_LINES), offset: 21 });
  assert.match(atLimit, /react-syntax-highlighter-line-number/);
  assert.doesNotMatch(atLimit, /shown as plain text/);

  const over = render({ filePath: "/tmp/big.ts", content: body(SOURCE_HIGHLIGHT_MAX_LINES + 1), offset: 21 });
  assert.doesNotMatch(over, /react-syntax-highlighter/);
  assert.match(over, new RegExp(`More than ${SOURCE_HIGHLIGHT_MAX_LINES} lines: shown as plain text`));
  // Plain, but still the file's own lines: the gutter runs the slice's whole span,
  // so a reader can still name the line to go back to.
  const numbers = [...over.matchAll(/data-line-number="(\d+)"/g)].map((match) => match[1]);
  assert.equal(numbers.length, SOURCE_HIGHLIGHT_MAX_LINES + 1);
  assert.equal(numbers[0], "21");
  assert.equal(numbers[numbers.length - 1], String(21 + SOURCE_HIGHLIGHT_MAX_LINES));
  // Nothing is dropped on the way to the fallback.
  assert.ok(over.includes(`const line${SOURCE_HIGHLIGHT_MAX_LINES} = ${SOURCE_HIGHLIGHT_MAX_LINES};`));
});

test("a delimited slice is a table, scroller included, and says where parsing starts", () => {
  const html = render({ filePath: "/tmp/a.csv", content: "alice,plain\nbob,\"two\nlines\"\n", offset: 40 });
  assert.match(html, /role="table"/);
  assert.match(html, /role="columnheader"[^>]*>#1</);
  // The gutter reads the file's lines, not the slice's: the header strip plus the
  // two records, the second of which spans lines 41 and 42.
  assert.deepEqual([...html.matchAll(/role="rowheader"[^>]*>([^<]*)</g)].map((match) => match[1]), ["40", "40", "41"]);
  // The component never scrolls itself; this box does — and it is the only scroller.
  assert.equal((html.match(/overflow:auto/g) ?? []).length, 1);
  // A slice cut inside a quoted multi-line field mis-splits for any parser: say so.
  assert.match(html, /Lines 40-42 of the file; parsing starts at line 40/);

  // A read from the top of the file has a header row and nothing to warn about.
  const top = render({ filePath: "/tmp/a.csv", content: "name,note\nalice,plain\n" });
  assert.match(top, /role="columnheader"[^>]*>name</);
  assert.doesNotMatch(top, /parsing starts at line/);
});

test("a slice with no record in it falls back to source instead of an empty table", () => {
  // DelimitedTable renders nothing for text with no record: the viewer must not
  // hand the panel a blank box.
  const html = render({ filePath: "/tmp/a.csv", content: "\n", offset: 12 });
  assert.doesNotMatch(html, /role="table"/);
  assert.match(html, /line-number[^>]*>12</);
});

test("the viewer holds the snapshot: it fetches nothing and never opens the live file", () => {
  assert.doesNotMatch(viewer, /fetch\(|XMLHttpRequest|\/api\/|EventSource|useSWR/);
  assert.doesNotMatch(viewer, /<FileViewer/);
  // Importing the source styling is all it takes from the file viewer, and the
  // snapshot's own content is what renders.
  assert.match(viewer, /import \{ FILE_CODE_STYLE, FILE_LINE_NUMBER_STYLE, SOURCE_HIGHLIGHT_MAX_LINES, fileViewerDarkTheme \} from "\.\/FileViewer"/);
  assert.match(viewer, /startingLineNumber=\{firstLine\}/);
});

test("the tab reaches the panel through the same machinery as file, terminal and sub-agent tabs", () => {
  assert.match(tabBar, /kind\?: "terminal" \| "agent" \| "read-snapshot"/);
  assert.match(tabBar, /tab\.kind === "read-snapshot" \? t\("readPanel\.tabLabel", \{ name: tab\.label \}\)/);

  assert.match(appShell, /const \[readTabs, setReadTabs\] = useState<\{ toolCallId: string; snapshot: ReadSnapshot \}\[\]\>\(\[\]\)/);
  assert.match(appShell, /const handleOpenReadSnapshot = useCallback\(\(toolCallId: string, snapshot: ReadSnapshot\) => \{/);
  assert.match(appShell, /setActiveFileTabId\(`read:\$\{toolCallId\}`\)/);
  assert.match(appShell, /kind: "read-snapshot" as const/);
  assert.match(appShell, /const activeReadTab = readTabs\.find\(\(tab\) => `read:\$\{tab\.toolCallId\}` === activeFileTabId\)/);
  assert.match(appShell, /<ReadSnapshotViewer[\s\S]*?filePath=\{activeReadTab\.snapshot\.filePath\}[\s\S]*?content=\{activeReadTab\.snapshot\.content\}[\s\S]*?offset=\{activeReadTab\.snapshot\.offset\}/);
  // One tab per call: re-opening a call replaces its tab's snapshot rather than adding a tab.
  assert.match(appShell, /prev\.some\(\(tab\) => tab\.toolCallId === toolCallId\)[\s\S]{0,120}prev\.map\(\(tab\) => tab\.toolCallId === toolCallId \? \{ \.\.\.tab, snapshot \} : tab/);
  // Closing one falls back to another tab of any kind, and closing the last of any kind folds the panel.
  assert.match(appShell, /if \(tabId\.startsWith\("read:"\)\) \{/);
  assert.match(appShell, /lastAgentTabId\(agentTabs\) \?\? lastReadTabId\(readTabs\)/);
  assert.match(appShell, /!agentTabs\.length && !readTabs\.length\) setRightPanelOpen\(false\)/);
  assert.match(appShell, /remainingAgents\.length === 0 && readTabs\.length === 0\) setRightPanelOpen\(false\)/);
  assert.match(appShell, /agentTabs\.length === 0 && remainingReads\.length === 0\) setRightPanelOpen\(false\)/);
  // The "no file open" placeholder must not show behind an active snapshot tab.
  assert.match(appShell, /&& !activeAgentTab && !activeReadTab \? \(/);
  // A snapshot came from this project's chat: a project switch drops them, unparked.
  assert.match(appShell, /setAgentTabs\(\[\]\);[\s\S]{0,160}setReadTabs\(\[\]\);/);
  assert.match(appShell, /activeFileTabId\.startsWith\("agent:"\) \|\| activeFileTabId\.startsWith\("read:"\)\)/);
  // It is a snapshot of a read, so no viewer state, watcher or path is involved:
  // FileViewer keeps the live-file tabs to itself.
  assert.equal((appShell.match(/<FileViewer/g) ?? []).length, 1);
  assert.match(appShell, /onOpenReadSnapshot=\{handleOpenReadSnapshot\}/);
});

test("a read card opens the panel from its header and keeps its body only as the fallback", () => {
  assert.match(messageView, /onOpenReadSnapshot\?: \(toolCallId: string, snapshot: ReadSnapshot\) => void/);
  // The decision is the lib's, so the card has one job: ask for the panel.
  assert.match(messageView, /readSnapshotOfCall\(\{[\s\S]*?toolName: block\.toolName,[\s\S]*?resultText,[\s\S]*?isError,[\s\S]*?hasImages: resultImages\.length > 0,[\s\S]*?streamingInput: isStreamingInput,/);
  assert.match(messageView, /onClick=\{readSnapshot \? \(\) => onOpenReadSnapshot\?\.\(block\.toolCallId, readSnapshot\) : toggleExpanded\}/);
  // No snapshot: the chevron and the expandable body are exactly as they were.
  assert.match(messageView, /const showBody = readSnapshot === null && expanded;/);
  assert.match(messageView, /\{readSnapshot \? \(\s*\/\/ The panel's own outline[\s\S]*?<\/svg>\s*\) : \(\s*<svg width="10" height="10"[\s\S]*?transform: expanded \? "rotate\(180deg\)"/);
  // Only the card's own body: a custom message and a compaction summary still
  // fold from their headers with their own `expanded`.
  const card = messageView.slice(
    messageView.indexOf("function ToolCallBlock("),
    messageView.indexOf("interface ResultDiff {"),
  );
  assert.notEqual(messageView.indexOf("function ToolCallBlock("), -1);
  assert.ok(card.length > 1000);
  assert.doesNotMatch(card, /\{expanded && /);
  assert.equal((card.match(/\{showBody && /g) ?? []).length, 5);
  // Result images stay put: an image read keeps the card that shows it.
  assert.match(messageView, /\{resultImages\.length > 0 && <ResultImages images=\{resultImages\} isError=\{isError\} \/>\}/);
});
