import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  flattenFileTree,
  fileTreeRowHeight,
  getFileTreeRowOffsets,
  FILE_TREE_ROW_HEIGHT,
  EMPTY_NOTE_HEIGHT,
} = await jiti.import("@/lib/file-tree-rows.ts");

const dir = (name, extra = {}) => ({ name, fullPath: `/r/${name}`, isDir: true, size: 0, children: [], loaded: true, ...extra });
const file = (name, extra = {}) => ({ name, fullPath: `/r/${name}`, isDir: false, size: 0, loaded: true, ...extra });

const noResolve = () => ({ loading: false, error: null, pendingLink: null, allowError: null });

test("flattens roots in order with depth and expansion", () => {
  const roots = [dir("a"), file("b.txt")];
  const rows = flattenFileTree(roots, new Set(["/r/a"]), (n) => n.children ?? null, noResolve);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, "/r/a");
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].key, "/r/b.txt");
  assert.equal(rows[1].expanded, false);
});

test("an open directory's loaded children follow it, one level deeper", () => {
  const roots = [dir("a", { children: [file("x", { fullPath: "/r/a/x" }), dir("b", { fullPath: "/r/a/b", children: [file("y", { fullPath: "/r/a/b/y" })] })] })];
  const rows = flattenFileTree(roots, new Set(["/r/a", "/r/a/b"]), (n) => n.children ?? null, noResolve);
  assert.deepEqual(rows.map((r) => [r.key, r.depth]), [
    ["/r/a", 0],
    ["/r/a/x", 1],
    ["/r/a/b", 1],
    ["/r/a/b/y", 2],
  ]);
});

test("an open directory that has not listed yet carries no children and no block", () => {
  const roots = [dir("a")];
  const rows = flattenFileTree(roots, new Set(["/r/a"]), () => null, () => ({ loading: true, error: null, pendingLink: null, allowError: null }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].loading, true);
  assert.equal(rows[0].block, undefined);
});

test("an open directory that lists nothing carries the empty block", () => {
  const roots = [dir("a", { children: [] })];
  const rows = flattenFileTree(roots, new Set(["/r/a"]), (n) => n.children ?? null, noResolve);
  assert.deepEqual(rows[0].block, { kind: "empty" });
});

test("a fetch error becomes the error block", () => {
  const roots = [dir("a")];
  const rows = flattenFileTree(roots, new Set(["/r/a"]), () => null, () => ({ loading: false, error: "boom", pendingLink: null, allowError: null }));
  assert.deepEqual(rows[0].block, { kind: "error", message: "boom" });
});

test("an unapproved outside link becomes the notice block when open and marks the row when collapsed", () => {
  const link = dir("a", { outsideLinkTarget: "/elsewhere", outsideLinkEncloses: true });
  const resolve = (n) => ({ loading: false, error: null, pendingLink: { target: n.outsideLinkTarget, encloses: true }, allowError: null });
  const open = flattenFileTree([link], new Set(["/r/a"]), () => null, resolve);
  assert.deepEqual(open[0].block, { kind: "notice", target: "/elsewhere", encloses: true, allowError: null });
  const collapsed = flattenFileTree([link], new Set(), () => null, resolve);
  assert.equal(collapsed[0].block, undefined);
  assert.deepEqual(collapsed[0].pendingLink, { target: "/elsewhere", encloses: true });
});

test("the notice block wins over an error and an empty list", () => {
  const link = dir("a", { outsideLinkTarget: "/elsewhere" });
  const rows = flattenFileTree([link], new Set(["/r/a"]), () => [], (n) => ({ loading: false, error: "boom", pendingLink: { target: n.outsideLinkTarget, encloses: false }, allowError: null }));
  assert.equal(rows[0].block.kind, "notice");
});

test("entries inside a hidden directory inherit its reason", () => {
  const roots = [dir("out", { hidden: "ignored", children: [file("a.js")] })];
  const rows = flattenFileTree(roots, new Set(["/r/out"]), (n) => n.children ?? null, noResolve);
  assert.equal(rows[0].hidden, "ignored");
  assert.equal(rows[1].hidden, "ignored");
});

test("row heights: the fixed row, the empty note, and the reserved error and notice blocks", () => {
  const base = { key: "k", node: file("f"), depth: 0, expanded: false, loading: false, pendingLink: null };
  assert.equal(fileTreeRowHeight(base), FILE_TREE_ROW_HEIGHT);
  assert.equal(fileTreeRowHeight({ ...base, block: { kind: "empty" } }), FILE_TREE_ROW_HEIGHT + EMPTY_NOTE_HEIGHT);
  assert.ok(fileTreeRowHeight({ ...base, block: { kind: "error", message: "x" } }) > FILE_TREE_ROW_HEIGHT);
  assert.ok(fileTreeRowHeight({ ...base, block: { kind: "notice", target: "/x", encloses: false } }) > FILE_TREE_ROW_HEIGHT);
});

test("offsets are the cumulative heights, ending at the full height", () => {
  const base = { node: file("f"), depth: 0, expanded: false, loading: false, pendingLink: null };
  const rows = [
    { ...base, key: "a" },
    { ...base, key: "b", block: { kind: "empty" } },
    { ...base, key: "c" },
  ];
  const offsets = getFileTreeRowOffsets(rows);
  assert.deepEqual(offsets, [0, FILE_TREE_ROW_HEIGHT, FILE_TREE_ROW_HEIGHT * 2 + EMPTY_NOTE_HEIGHT, FILE_TREE_ROW_HEIGHT * 3 + EMPTY_NOTE_HEIGHT]);
});

test("a new folder is named above its parent's entries, and a rename in the row itself", () => {
  const roots = [dir("out", { children: [file("a.js")] })];
  const expanded = new Set(["/r", "/r/out"]);
  const children = (n) => n.children ?? null;
  const rows = flattenFileTree(roots, expanded, children, noResolve, { root: "/r", creatingIn: "/r/out" });

  // The root has no row of its own here, so the new folder's row leads its entries.
  const created = rows.find((row) => row.edit?.kind === "create");
  assert.deepEqual(created.edit, { kind: "create", directory: "/r/out" });
  assert.equal(created.depth, 1);
  assert.equal(created.key, "new:/r/out");
  // It sits above the folder's first entry, not after them.
  assert.ok(rows.indexOf(created) < rows.findIndex((row) => row.node.name === "a.js"));

  const renaming = flattenFileTree(roots, expanded, children, noResolve, { root: "/r", renamingPath: "/r/a.js" });
  assert.deepEqual(renaming.find((row) => row.node.fullPath === "/r/a.js").edit, { kind: "rename", initial: "a.js" });
});

test("a new folder at the tree's root leads the root's entries", () => {
  const roots = [file("a.js")];
  const rows = flattenFileTree(roots, new Set(), (n) => n.children ?? null, noResolve, { root: "/r", creatingIn: "/r" });
  assert.deepEqual(rows[0].edit, { kind: "create", directory: "/r" });
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[1].node.name, "a.js");
});

test("a new folder inside a collapsed or unapproved folder is not laid out", () => {
  const roots = [dir("out", { children: [] })];
  const collapsed = flattenFileTree(roots, new Set(), (n) => n.children ?? null, noResolve, { root: "/r", creatingIn: "/r/out" });
  assert.equal(collapsed.some((row) => row.edit), false);

  const link = dir("link", { outsideLinkTarget: "/elsewhere", children: [] });
  const pending = flattenFileTree([link], new Set(["/r/link"]), (n) => n.children ?? null, (n) => ({ loading: false, error: null, pendingLink: { target: n.outsideLinkTarget, encloses: false }, allowError: null }), { root: "/r", creatingIn: "/r/link" });
  assert.equal(pending.some((row) => row.edit), false);
});
