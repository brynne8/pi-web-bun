import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { WindowedList } = await jiti.import("./FileExplorer.tsx");
const { FILE_TREE_ROW_HEIGHT } = await jiti.import("@/lib/file-tree-rows.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { translateMessage } = await jiti.import("@/lib/i18n/format.ts");

const t = (key, params) => translateMessage("en", key, { en: enLocale.messages }, params);

function buildRows(count) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const path = `/r/f${index}.txt`;
    rows.push({
      kind: "tree",
      key: path,
      row: { key: path, node: { name: `f${index}.txt`, fullPath: path, isDir: false, size: 0 }, depth: 0, expanded: false, loading: false, pendingLink: null },
      onToggle() {},
    });
  }
  return rows;
}

function renderList(rows, overrides = {}) {
  return renderToStaticMarkup(React.createElement(WindowedList, {
    rows,
    scrollTop: 0,
    viewportHeight: 0,
    offsetAbove: 0,
    gitStatusByPath: new Map(),
    changedDirectoryPaths: new Set(),
    highlightedPaths: new Set(),
    dropTargetPath: null,
    handlers: { current: { onOpenFile() {}, onAllowLink() {} } },
    cwd: "/r",
    t,
    listRef: { current: null },
    ...overrides,
  }));
}

test("a 3000-row list mounts only a window of rows, not all of them", () => {
  const html = renderList(buildRows(3000));
  const mounted = (html.match(/data-file-row-path=/g) ?? []).length;
  assert.ok(mounted > 0 && mounted < 100, `only a window of rows is mounted, got ${mounted}`);
  // The spacer carries the full height so the scrollbar is honest.
  assert.match(html, new RegExp(`height:${3000 * FILE_TREE_ROW_HEIGHT}px`));
});

test("a keep-mounted row is rendered even when it is outside the window", () => {
  const rows = buildRows(3000);
  // The last row is far below an unmeasured (600px) viewport; highlighting it keeps it mounted.
  const html = renderList(rows, { highlightedPaths: new Set(["/r/f2999.txt"]) });
  assert.match(html, /data-file-row-path="\/r\/f2999\.txt"/);
});
