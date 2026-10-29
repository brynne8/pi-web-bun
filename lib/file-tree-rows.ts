import type { FileTreeHiddenReason } from "./file-tree-visibility";

/** Why a listed entry is normally left out; only listings with `hidden=1` report it. */
export type HiddenReason = Exclude<FileTreeHiddenReason, "always">;

/**
 * One entry of the file tree as a listing reports it. The explorer keeps the
 * loaded children of an open directory beside it (`children`) so the flat row
 * list can include them; a collapsed or not-yet-listed directory leaves it
 * undefined.
 */
export interface FileTreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileTreeNode[];
  loaded?: boolean;
  /** Where a directory link leads when that is outside the browsable roots. */
  outsideLinkTarget?: string;
  /** That target contains the project or the home folder. */
  outsideLinkEncloses?: boolean;
  hidden?: HiddenReason;
}

/** The fixed height of one file-tree row. */
export const FILE_TREE_ROW_HEIGHT = 24;
/** The "empty" note under an open directory that lists nothing. */
export const EMPTY_NOTE_HEIGHT = 22;
// A load error and an outside-link notice are the only variable-height blocks.
// Both are rare (a failed fetch, a symlink leaving the roots) and sit on a
// directory with no listed children, so a fixed reservation that fits the usual
// text keeps the offset arithmetic exact for every other row.
const ERROR_BLOCK_HEIGHT = 60;
const NOTICE_BLOCK_HEIGHT = 120;

/** Shown under an open directory that lists nothing: its empty note, a fetch error, or an unapproved outside link. */
export type FileRowBlock =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "notice"; target: string; encloses: boolean; allowError?: string | null };

/** One flattened, windowable row of the file tree. */
export interface FlatTreeRow {
  key: string;
  node: FileTreeNode;
  depth: number;
  expanded: boolean;
  hidden?: HiddenReason;
  loading: boolean;
  /** Set when this directory is a symlink leaving the roots that has not been allowed yet. */
  pendingLink?: { target: string; encloses: boolean } | null;
  block?: FileRowBlock;
}

/** An open directory's load state, read while flattening. */
export interface DirResolve {
  loading: boolean;
  error: string | null;
  pendingLink: { target: string; encloses: boolean } | null;
  allowError?: string | null;
}

/**
 * The expanded tree as one flat list of rows, in render order. A directory's
 * already-loaded children follow it; a directory that is open but lists nothing
 * carries the block that says why (empty, a fetch error, or an outside link
 * awaiting approval). `getChildren` returns an open directory's loaded entries
 * (or null while it loads); `resolve` reports its loading, error and link state.
 */
export function flattenFileTree(
  roots: readonly FileTreeNode[],
  expandedPaths: ReadonlySet<string>,
  getChildren: (node: FileTreeNode) => readonly FileTreeNode[] | null,
  resolve: (node: FileTreeNode) => DirResolve,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const walk = (nodes: readonly FileTreeNode[], depth: number, parentHidden?: HiddenReason): void => {
    for (const node of nodes) {
      const hidden = node.hidden ?? parentHidden;
      const expanded = node.isDir && expandedPaths.has(node.fullPath);
      // The link state is read for every directory (a collapsed one still marks
      // itself); loading and error only matter once it is open.
      const state: DirResolve = node.isDir
        ? resolve(node)
        : { loading: false, error: null, pendingLink: null, allowError: null };
      const children = expanded ? getChildren(node) : null;
      let block: FileRowBlock | undefined;
      if (expanded) {
        if (state.pendingLink) {
          block = { kind: "notice", target: state.pendingLink.target, encloses: state.pendingLink.encloses, allowError: state.allowError ?? null };
        } else if (state.error) {
          block = { kind: "error", message: state.error };
        } else if (children && children.length === 0) {
          block = { kind: "empty" };
        }
      }
      rows.push({
        key: node.fullPath,
        node,
        depth,
        expanded,
        hidden,
        loading: expanded && state.loading,
        pendingLink: state.pendingLink,
        block,
      });
      if (children && children.length > 0) walk(children, depth + 1, hidden);
    }
  };
  walk(roots, 0);
  return rows;
}

/** A row's height: the row plus any block shown under it. */
export function fileTreeRowHeight(row: FlatTreeRow): number {
  if (!row.block) return FILE_TREE_ROW_HEIGHT;
  if (row.block.kind === "empty") return FILE_TREE_ROW_HEIGHT + EMPTY_NOTE_HEIGHT;
  if (row.block.kind === "error") return FILE_TREE_ROW_HEIGHT + ERROR_BLOCK_HEIGHT;
  return FILE_TREE_ROW_HEIGHT + NOTICE_BLOCK_HEIGHT;
}

/** `offsets[i]` is the top of row `i`, `offsets[rows.length]` the list's full height. */
export function getFileTreeRowOffsets(rows: readonly FlatTreeRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index + 1] = offsets[index] + fileTreeRowHeight(rows[index]);
  }
  return offsets;
}
