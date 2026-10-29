import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { FileRow } = await jiti.import("./FileExplorer.tsx");
const { flattenFileTree } = await jiti.import("@/lib/file-tree-rows.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { translateMessage } = await jiti.import("@/lib/i18n/format.ts");

const t = (key, params) => translateMessage("en", key, { en: enLocale.messages }, params);
const handlers = { current: { onOpenFile() {}, onAllowLink() {} } };

const file = (name, extra = {}) => ({
  name,
  fullPath: `/repo/${name}`,
  isDir: false,
  size: 0,
  loaded: true,
  ...extra,
});

// Flatten the roots with the given open directories and loaded children, then
// render every row the way the windowed list would.
function renderRows(roots, { expandedPaths = new Set(), childrenOf = () => null } = {}) {
  const rows = flattenFileTree(roots, expandedPaths, childrenOf, () => ({ loading: false, error: null, pendingLink: null, allowError: null }));
  return rows.map((row) => renderToStaticMarkup(React.createElement(FileRow, {
    row,
    isDropTarget: false,
    highlighted: false,
    gitStatus: null,
    containsChanges: false,
    onToggle() {},
    handlers,
    t,
  })));
}

test("an entry Git ignores is dimmed and says why", () => {
  const html = renderRows([file("debug.log", { hidden: "ignored" })])[0];
  assert.match(html, /data-hidden-reason="ignored"/);
  assert.match(html, /opacity:0\.55/);
  assert.match(html, /title="\/repo\/debug\.log\nIgnored by Git"/);
});

test("an entry the fallback name list hides names that reason", () => {
  const html = renderRows([file("node_modules", { isDir: true, loaded: false, children: [], hidden: "excluded" })])[0];
  assert.match(html, /data-hidden-reason="excluded"/);
  assert.match(html, /Hidden by default/);
});

test("entries inside a hidden directory inherit its reason", () => {
  const html = renderRows([file("index.js", { hidden: "ignored" })])[0];
  assert.match(html, /data-hidden-reason="ignored"/);
});

test("an open hidden directory passes its reason to the entries it lists", () => {
  const dir = {
    name: "out",
    fullPath: "/repo/out",
    isDir: true,
    size: 0,
    loaded: true,
    hidden: "ignored",
    children: [file("out/a.js", { name: "a.js", fullPath: "/repo/out/a.js" })],
  };
  const html = renderRows([dir], {
    expandedPaths: new Set(["/repo/out"]),
    childrenOf: (node) => node.children ?? null,
  }).join("");
  assert.equal(html.match(/data-hidden-reason="ignored"/g)?.length, 2);
});

test("ordinary entries are not dimmed", () => {
  const html = renderRows([file("README.md")])[0];
  assert.doesNotMatch(html, /data-hidden-reason/);
  assert.match(html, /title="\/repo\/README\.md"/);
});
