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
const { FileRow } = await jiti.import("./FileExplorer.tsx");
const { flattenFileTree } = await jiti.import("@/lib/file-tree-rows.ts");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { translateMessage } = await jiti.import("@/lib/i18n/format.ts");

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const t = (key, params) => translateMessage("en", key, { en: enLocale.messages }, params);
const handlers = { current: { onOpenFile() {}, onAllowLink() {} } };

const linkedNode = {
  name: "linked",
  fullPath: "/hub/linked",
  isDir: true,
  size: 0,
  children: [],
  loaded: false,
  outsideLinkTarget: "/elsewhere/project",
};

// Flatten a single directory the way the explorer does, then render its row.
function renderRow(node, { open = false, resolve } = {}) {
  const expandedPaths = new Set(open ? [node.fullPath] : []);
  const rows = flattenFileTree(
    [node],
    expandedPaths,
    (n) => n.children ?? null,
    resolve ?? (() => ({ loading: false, error: null, pendingLink: null, allowError: null })),
  );
  return renderToStaticMarkup(React.createElement(FileRow, {
    row: rows[0],
    isDropTarget: false,
    highlighted: false,
    gitStatus: null,
    containsChanges: false,
    onToggle() {},
    handlers,
    t,
  }));
}

// A link that leaves the project is pending until allowed: the explorer reports it.
const pendingLinkResolve = (node) => ({
  loading: false,
  error: null,
  pendingLink: node.outsideLinkTarget ? { target: node.outsideLinkTarget, encloses: Boolean(node.outsideLinkEncloses) } : null,
  allowError: null,
});

test("an expanded link that leaves the project names its target and offers to allow it", () => {
  const html = renderRow(linkedNode, { open: true, resolve: pendingLinkResolve });
  assert.match(html, /Links to \/elsewhere\/project, outside this project/);
  assert.match(html, /<button type="button" title="Browse \/elsewhere\/project until Pi Web restarts[^"]*"[^>]*>Allow browsing<\/button>/);
  assert.doesNotMatch(html, />empty</);
});

test("a collapsed link that leaves the project is marked on its row", () => {
  const html = renderRow(linkedNode, { open: false, resolve: pendingLinkResolve });
  assert.match(html, /aria-label="Links to \/elsewhere\/project, outside this project"/);
  assert.doesNotMatch(html, /Allow browsing/);
});

test("ordinary directories render no link notice", () => {
  const html = renderRow({ ...linkedNode, outsideLinkTarget: undefined, children: [], loaded: true }, { open: true });
  assert.doesNotMatch(html, /outside this project|Allow browsing/);
  assert.match(html, />empty</);
});

test("a link that encloses the project or home folder warns and confirms before allowing", () => {
  const html = renderRow({ ...linkedNode, outsideLinkTarget: "/", outsideLinkEncloses: true }, { open: true, resolve: pendingLinkResolve });
  assert.match(html, /That folder contains this project or your home folder\./);
  assert.doesNotMatch(renderRow(linkedNode, { open: true, resolve: pendingLinkResolve }), /contains this project/);
  assert.match(source, /if \(encloses && !window\.confirm\(t\("files\.allowEnclosingLinkConfirm"/);
});
