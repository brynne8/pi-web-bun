"use client";

import { forwardRef, memo, useState, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { DismissButton } from "./DismissButton";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { uploadFiles, type DroppedItem, type UploadConflictStrategy, type UploadError, type UploadResponse } from "@/lib/file-upload-client";
import { buildSearchTree, type SearchTreeNode } from "@/lib/search-tree";
import type { FileTreeHiddenReason } from "@/lib/file-tree-visibility";
import { createExpandedPathsMemory } from "@/lib/file-tree-expansion";
import { droppedItems } from "@/hooks/useDragDrop";
import { useI18n } from "@/hooks/useI18n";
import { getVisibleRowIndices, revealScrollTop } from "@/lib/session-tree";
import {
  flattenFileTree,
  getFileTreeRowOffsets,
  FILE_TREE_ROW_HEIGHT,
  EMPTY_NOTE_HEIGHT,
  type DirResolve,
  type FileTreeNode,
  type FlatTreeRow,
} from "@/lib/file-tree-rows";
type Translate = ReturnType<typeof useI18n>["t"];

type HiddenReason = Exclude<FileTreeHiddenReason, "always">;
type FileNode = FileTreeNode;

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
  /** Where a directory link leads when that is outside the browsable roots. */
  outsideLinkTarget?: string;
  /** That target contains the project or the home folder. */
  outsideLinkEncloses?: boolean;
  hidden?: HiddenReason;
}

/**
 * One row of the file tree, or of the changed-files list, as the row's right-click
 * menu receives it. `relativePath` is what a mention inserts into the chat (the
 * same words the `@` picker types); `path` is what a download and a reveal act on.
 */
export interface FileRowTarget {
  /** Absolute path on the machine Pi Web runs on. */
  path: string;
  /** The same path from the project root. */
  relativePath: string;
  name: string;
  isDir: boolean;
  /**
   * The file's Git status, or null when the folder is not a repository or this
   * path has no changes. The row's menu reads it to decide whether a Revert
   * makes sense (lib/git-revert-rule.ts); a directory row never carries one.
   */
  gitStatus: GitFileStatus | null;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  /**
   * Opens a row's menu at the pointer. A row acts through this menu and through
   * nothing else: the actions used to be two buttons drawn over the row's own
   * name on hover, which covered the part of the row a reader aims at (see the
   * file-row bullet in docs/agents/tests.md). Without this prop a row has no
   * menu and keeps the browser's own one.
   */
  onRowMenu?: (target: FileRowTarget, position: { x: number; y: number }) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
  /** Also list what Git ignores, dimmed (the explorer bar's switch). */
  showHidden?: boolean;
  /**
   * False while the files panel has not been looked at yet: the tree lists no
   * directory until it is, so opening the page spawns no git process for a
   * panel the reader never opens. The changed-files count is not part of the
   * tree and keeps loading either way.
   */
  treeVisible?: boolean;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";

// Each folder's open directories for the page's life, so moving to another
// project and back (a session picked in another group) does not fold the tree.
const expandedPathsByCwd = createExpandedPathsMemory();

/** One directory's listing state, kept beside the tree so the flat rows can include its entries. */
interface DirLoad {
  children: FileNode[] | null;
  loading: boolean;
  error: string | null;
}

interface UploadSummary {
  directory: string;
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  directory: string;
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

/** The row's own actions, read at event time so a memoized row needs no new callbacks. */
interface RowHandlers {
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAllowLink: (fullPath: string, target: string, encloses: boolean) => void;
  onDropFiles?: (directory: string, items: DroppedItem[]) => void;
  onDropTargetChange?: (path: string | null) => void;
}

async function responseError(res: Response, fallback: string): Promise<Error> {
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const data = await res.json() as { error?: string };
    if (data.error) message = data.error;
  } catch {
    // ignore non-JSON error bodies
  }
  return new Error(message);
}

async function fetchEntries(dirPath: string, showHidden = false): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list${showHidden ? "&hidden=1" : ""}`);
  if (!res.ok) throw await responseError(res, "Failed to load files");
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
    outsideLinkTarget: e.outsideLinkTarget,
    outsideLinkEncloses: e.outsideLinkEncloses,
    hidden: e.hidden,
  }));
}

// Sends the target the operator was shown, so a link pointed elsewhere since
// the listing is refused instead of granting a directory nobody looked at.
async function allowOutsideLink(linkPath: string, target: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(linkPath)}?type=allow-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) throw await responseError(res, "Failed to allow the linked folder");
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function OutsideLinkIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

// Listed only while the explorer shows ignored files: dimmed like VS Code's
// ignored entries, the reason in the name's tooltip.
const HIDDEN_ENTRY_OPACITY = 0.55;
const HIDDEN_REASON_KEYS = {
  ignored: "files.hiddenIgnored",
  excluded: "files.hiddenExcluded",
} as const satisfies Record<HiddenReason, string>;

/**
 * One row of the windowed tree (or the search results): the 24px entry line and,
 * under an open directory that lists nothing, the block that says why. It reads
 * its handlers at event time and takes only stable props, so a parent re-render
 * (the 2.5 s running poll, a Git refresh) re-renders nothing that did not change.
 */
export const FileRow = memo(function FileRow({
  row,
  isDropTarget,
  highlighted,
  gitStatus,
  containsChanges,
  onToggle,
  handlers,
  t,
}: {
  row: FlatTreeRow;
  isDropTarget: boolean;
  highlighted: boolean;
  gitStatus: GitFileStatus | null;
  containsChanges: boolean;
  onToggle: (fullPath: string, open: boolean) => void;
  handlers: RefObject<RowHandlers>;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const { node, depth, expanded, hidden, loading, pendingLink, block } = row;
  const pendingLinkTarget = pendingLink ? pendingLink.target : null;

  const handleClick = useCallback(() => {
    if (node.isDir) onToggle(node.fullPath, !expanded);
    else handlers.current.onOpenFile(node.fullPath, node.name);
  }, [node.isDir, node.fullPath, node.name, expanded, onToggle, handlers]);

  return (
    <div>
      <div
        onClick={handleClick}
        // What the right-click menu acts on, read at the explorer's root: every
        // row of the tree, the search results and the changed list says the same
        // thing about itself, so a new kind of row is not left without a menu.
        data-file-row-path={node.fullPath}
        data-file-row-is-dir={node.isDir ? "true" : "false"}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onDragOver={node.isDir ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          handlers.current.onDropTargetChange?.(node.fullPath);
        } : undefined}
        onDrop={node.isDir ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          handlers.current.onDropTargetChange?.(null);
          handlers.current.onDropFiles?.(node.fullPath, droppedItems(event.dataTransfer));
        } : undefined}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: FILE_TREE_ROW_HEIGHT,
          cursor: "pointer",
          background: isDropTarget
            ? "color-mix(in srgb, var(--accent) 16%, transparent)"
            : hovered
              ? "var(--bg-hover)"
              : "transparent",
          outline: isDropTarget ? "1px dashed var(--accent)" : "none",
          outlineOffset: -1,
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: hidden ? HIDDEN_ENTRY_OPACITY : 1 }}>
          {node.isDir ? <FolderIcon size={14} open={expanded} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          data-hidden-reason={hidden}
          style={{
            fontSize: 12,
            color: hidden ? "var(--text-muted)" : "var(--text)",
            opacity: hidden ? HIDDEN_ENTRY_OPACITY : 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={hidden ? `${node.fullPath}\n${t(HIDDEN_REASON_KEYS[hidden])}` : node.fullPath}
        >
          {node.name}
        </span>
        {!hovered && pendingLinkTarget && (
          <span
            title={t("files.outsideLink", { target: pendingLinkTarget })}
            aria-label={t("files.outsideLink", { target: pendingLinkTarget })}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}
          >
            <OutsideLinkIcon />
          </span>
        )}
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
      </div>
      {block?.kind === "notice" && (
        <div
          style={{
            paddingLeft: 8 + (depth + 1) * 14,
            paddingRight: 8,
            paddingTop: 3,
            paddingBottom: 5,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 4,
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          <span style={{ wordBreak: "break-all" }}>{t("files.outsideLink", { target: block.target })}</span>
          {block.encloses && (
            <span style={{ color: "#f59e0b" }}>{t("files.outsideLinkEncloses")}</span>
          )}
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); handlers.current.onAllowLink(node.fullPath, block.target, block.encloses); }}
            title={t("files.allowOutsideLinkTitle", { target: block.target })}
            style={{
              height: 20,
              padding: "0 8px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            {t("files.allowOutsideLink")}
          </button>
          {block.allowError && (
            <span role="alert" style={{ color: "#f87171", wordBreak: "break-word" }}>{block.allowError}</span>
          )}
        </div>
      )}
      {block?.kind === "empty" && (
        <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: EMPTY_NOTE_HEIGHT, display: "flex", alignItems: "center" }}>
          empty
        </div>
      )}
      {block?.kind === "error" && (
        <div role="alert" style={{ paddingLeft: 8 + (depth + 1) * 14, paddingRight: 8, paddingTop: 3, paddingBottom: 3, fontSize: 11, color: "#f87171", wordBreak: "break-word" }}>
          {block.message}
        </div>
      )}
    </div>
  );
});

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

const ChangeRow = memo(function ChangeRow({
  status,
  cwd,
  handlers,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  handlers: RefObject<RowHandlers>;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  // Split the path so the directory part ellipsizes while the file name stays fully visible
  const lastSlash = rel.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
  const baseName = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
  return (
    <div
      onClick={() => handlers.current.onOpenFile(status.filePath, name, { modeHint: "diff" })}
      data-file-row-path={status.filePath}
      data-file-row-is-dir="false"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        height: FILE_TREE_ROW_HEIGHT,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
        position: "relative",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        title={status.filePath}
        style={{
          fontSize: 12,
          color: "var(--text)",
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          flex: 1,
        }}
      >
        {dirPart && (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: "0 1 auto",
              minWidth: 0,
              color: "var(--text-dim)",
            }}
          >
            {dirPart}
          </span>
        )}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flexShrink: 0,
            maxWidth: "100%",
          }}
        >
          {baseName}
        </span>
      </span>
    </div>
  );
});

/** One row of the explorer's single windowed scroller: a tree entry, a changed file, the changes header, or a one-line note. */
type DisplayRow =
  | { kind: "tree"; key: string; row: FlatTreeRow; onToggle: (fullPath: string, open: boolean) => void }
  | { kind: "change"; key: string; status: GitFileStatus }
  | { kind: "change-header"; key: string; count: number; additions: number; deletions: number }
  | { kind: "message"; key: string; text: string; tone?: "error" };

function displayRowHeight(row: DisplayRow): number {
  if (row.kind === "tree") {
    if (!row.row.block) return FILE_TREE_ROW_HEIGHT;
    if (row.row.block.kind === "empty") return FILE_TREE_ROW_HEIGHT + EMPTY_NOTE_HEIGHT;
    return FILE_TREE_ROW_HEIGHT + (row.row.block.kind === "error" ? 60 : 120);
  }
  return FILE_TREE_ROW_HEIGHT;
}

/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN_PX = 240;

/** One tree entry as the windowed list and the (small) search results both render it. */
function renderTreeRow(
  row: FlatTreeRow,
  onToggle: (fullPath: string, open: boolean) => void,
  maps: { gitStatusByPath: Map<string, GitFileStatus>; changedDirectoryPaths: Set<string>; highlightedPaths: Set<string>; dropTargetPath: string | null },
  handlers: RefObject<RowHandlers>,
  t: Translate,
) {
  const normalizedPath = normalizeFilePathSlashes(row.node.fullPath);
  const gitStatus = maps.gitStatusByPath.get(normalizedPath) ?? null;
  const containsChanges = row.node.isDir && (gitStatus !== null || maps.changedDirectoryPaths.has(normalizedPath));
  const isDropTarget = row.node.isDir && maps.dropTargetPath === row.node.fullPath;
  const highlighted = maps.highlightedPaths.has(row.node.fullPath);
  return (
    <FileRow
      row={row}
      isDropTarget={isDropTarget}
      highlighted={highlighted}
      gitStatus={gitStatus}
      containsChanges={containsChanges}
      onToggle={onToggle}
      handlers={handlers}
      t={t}
    />
  );
}

/**
 * A windowed list: it renders only the rows intersecting the viewport (plus
 * overscan and any kept-mounted row), absolutely positioned inside a spacer of
 * the full height, so a 3000-entry directory mounts a few dozen rows. Rows are
 * `FileRow` / `ChangeRow` (both memoized on stable props), so an idle re-render
 * (the 2.5 s running poll, a Git refresh) touches none of them. The tree and the
 * changed-files list are mutually exclusive, so only one is mounted at a time;
 * `offsetAbove` is where its first row sits inside the sidebar's scroller.
 */
export const WindowedList = memo(function WindowedList({
  rows,
  scrollTop,
  viewportHeight,
  offsetAbove,
  gitStatusByPath,
  changedDirectoryPaths,
  highlightedPaths,
  dropTargetPath,
  handlers,
  cwd,
  t,
  listRef,
}: {
  rows: DisplayRow[];
  scrollTop: number;
  viewportHeight: number;
  offsetAbove: number;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  highlightedPaths: Set<string>;
  dropTargetPath: string | null;
  handlers: RefObject<RowHandlers>;
  cwd: string;
  t: Translate;
  listRef: RefObject<HTMLDivElement | null>;
}) {
  const offsets = useMemo(() => {
    const result = new Array<number>(rows.length + 1);
    result[0] = 0;
    for (let index = 0; index < rows.length; index += 1) result[index + 1] = result[index] + displayRowHeight(rows[index]);
    return result;
  }, [rows]);
  // A highlighted row (files just uploaded) and the row under a drag stay
  // mounted even when scrolled away.
  const keepMounted = useMemo(() => {
    const indices: number[] = [];
    rows.forEach((row, index) => {
      if (row.kind !== "tree") return;
      if (highlightedPaths.has(row.row.node.fullPath)) indices.push(index);
      else if (row.row.node.isDir && dropTargetPath === row.row.node.fullPath) indices.push(index);
    });
    return indices;
  }, [rows, highlightedPaths, dropTargetPath]);
  const effectiveScrollTop = Math.max(0, scrollTop - offsetAbove);
  const visibleIndices = useMemo(
    () => getVisibleRowIndices(offsets, effectiveScrollTop, viewportHeight, OVERSCAN_PX, keepMounted),
    [offsets, effectiveScrollTop, viewportHeight, keepMounted],
  );
  const totalHeight = offsets[rows.length] ?? 0;
  const maps = { gitStatusByPath, changedDirectoryPaths, highlightedPaths, dropTargetPath };
  return (
    <div ref={listRef} style={{ position: "relative", height: totalHeight }}>
      {visibleIndices.map((index) => {
        const row = rows[index];
        const top = offsets[index];
        const height = offsets[index + 1] - top;
        const wrapper = { position: "absolute" as const, top, left: 0, right: 0, height };
        if (row.kind === "tree") {
          return <div key={row.key} style={wrapper}>{renderTreeRow(row.row, row.onToggle, maps, handlers, t)}</div>;
        }
        if (row.kind === "change") {
          return (
            <div key={row.key} style={wrapper}>
              <ChangeRow status={row.status} cwd={cwd} handlers={handlers} t={t} />
            </div>
          );
        }
        if (row.kind === "change-header") {
          return (
            <div
              key={row.key}
              style={wrapper}
              aria-label={t("files.changeStats", { count: row.count, additions: row.additions, deletions: row.deletions })}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, height: FILE_TREE_ROW_HEIGHT, padding: "0 10px", fontSize: 12 }}>
                <span style={{ color: "var(--text-dim)" }}>{t("files.changedCount", { count: row.count })}</span>
                <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{row.additions}</span>
                <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{row.deletions}</span>
              </div>
            </div>
          );
        }
        return (
          <div
            key={row.key}
            style={{ ...wrapper, display: "flex", alignItems: "center", padding: "0 12px", fontSize: 11, color: row.tone === "error" ? "#f87171" : "var(--text-dim)" }}
          >
            {row.text}
          </div>
        );
      })}
    </div>
  );
});

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onRowMenu,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onChangesCountChange,
  fileSearchOpen = false,
  onFileSearchOpenChange,
  showHidden = false,
  treeVisible = true,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirLoads, setDirLoads] = useState<Map<string, DirLoad>>(new Map());
  const [allowedLinkTargets, setAllowedLinkTargets] = useState<Map<string, string>>(new Map());
  const [linkErrors, setLinkErrors] = useState<Map<string, string>>(new Map());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ scrollTop: 0, viewportHeight: 0, offsetAbove: 0 });
  const fileDragDepthRef = useRef(0);
  const prevCwdRef = useRef<string | null>(null);
  const expandedPathsRef = useRef(expandedPaths);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const aboveRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dirLoadsRef = useRef(dirLoads);
  dirLoadsRef.current = dirLoads;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const treeRowsRef = useRef<FlatTreeRow[]>([]);
  const revealDoneRef = useRef("");
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const hasSearchQuery = searchQuery.trim().length > 0;

  const loadDir = useCallback(async (path: string) => {
    setDirLoads((prev) => {
      const existing = prev.get(path);
      if (existing?.loading) return prev;
      const next = new Map(prev);
      next.set(path, { children: existing?.children ?? null, loading: true, error: null });
      return next;
    });
    try {
      const entries = await fetchEntries(path, showHiddenRef.current);
      setDirLoads((prev) => {
        const next = new Map(prev);
        next.set(path, { children: entries, loading: false, error: null });
        return next;
      });
    } catch (loadError) {
      setDirLoads((prev) => {
        const next = new Map(prev);
        next.set(path, { children: null, loading: false, error: loadError instanceof Error ? loadError.message : String(loadError) });
        return next;
      });
    }
  }, []);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
    // A directory that last failed to list (or has not been listed) lists now;
    // the orchestration effect covers the not-yet-attempted case, this retries.
    if (open) {
      const load = dirLoadsRef.current.get(fullPath);
      if (load && load.error !== null && !load.loading) void loadDir(fullPath);
    }
  }, [loadDir]);

  const handleSearchToggle = useCallback((fullPath: string, open: boolean) => {
    setSearchExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleAllowLink = useCallback(async (fullPath: string, target: string, encloses: boolean) => {
    // A link to `/`, `~` or a parent of the project opens far more than a
    // sibling folder, and a cloned repository can contain one.
    if (encloses && !window.confirm(t("files.allowEnclosingLinkConfirm", { target }))) return;
    try {
      await allowOutsideLink(fullPath, target);
      setAllowedLinkTargets((prev) => { const next = new Map(prev); next.set(fullPath, target); return next; });
      setLinkErrors((prev) => { const next = new Map(prev); next.delete(fullPath); return next; });
      await loadDir(fullPath);
    } catch (allowError) {
      setLinkErrors((prev) => {
        const next = new Map(prev);
        next.set(fullPath, allowError instanceof Error ? allowError.message : String(allowError));
        return next;
      });
    }
  }, [t, loadDir]);

  const handlersRef = useRef<RowHandlers>({ onOpenFile: () => {}, onAllowLink: () => {} });

  // Reuse the cached, bounded file index used by @ mentions.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ matches?: FileIndexEntry[] }> : Promise.reject(new Error("Search failed")))
        .then((data) => setSearchPaths((data.matches ?? []).filter((entry) => !entry.isDir).map((entry) => entry.path)))
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchPaths([]);
            setSearchError(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, fileSearchOpen, searchQuery]);

  // Focus the search input whenever the search panel opens.
  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus();
  }, [fileSearchOpen]);

  // Results render as a tree; keep every directory that contains a match
  // expanded, while preserving the user's manual collapses as they type.
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        dirs.add(joinFilePath(cwd, path));
      }
    }
    setSearchExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [cwd, searchPaths]);

  const searchRoots = useMemo(() => {
    const toFileNode = (node: SearchTreeNode): FileNode => ({
      name: node.name,
      fullPath: joinFilePath(cwd, node.path),
      isDir: node.isDir,
      size: 0,
      children: node.children.map(toFileNode),
      loaded: true,
    });
    return buildSearchTree(searchPaths).map(toFileNode);
  }, [cwd, searchPaths]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  // The tree's flat rows: the roots, each open directory's already-loaded
  // children under it, and the block that says why an open directory lists
  // nothing (empty, a fetch error, or an outside link awaiting approval).
  const treeRows = useMemo(() => flattenFileTree(
    roots,
    expandedPaths,
    (node) => dirLoads.get(node.fullPath)?.children ?? null,
    (node): DirResolve => {
      const load = dirLoads.get(node.fullPath);
      const approved = node.outsideLinkTarget !== undefined && allowedLinkTargets.get(node.fullPath) === node.outsideLinkTarget;
      const pendingLink = node.outsideLinkTarget && !approved
        ? { target: node.outsideLinkTarget, encloses: Boolean(node.outsideLinkEncloses) }
        : null;
      return {
        loading: load?.loading ?? false,
        error: load?.error ?? null,
        pendingLink,
        allowError: pendingLink ? (linkErrors.get(node.fullPath) ?? null) : null,
      };
    },
  ), [roots, expandedPaths, dirLoads, allowedLinkTargets, linkErrors]);
  treeRowsRef.current = treeRows;

  const searchRows = useMemo(() => {
    if (!(fileSearchOpen && hasSearchQuery) || searchLoading || searchError || searchPaths.length === 0) return [];
    return flattenFileTree(
      searchRoots,
      searchExpanded,
      (node) => node.children ?? null,
      () => ({ loading: false, error: null, pendingLink: null, allowError: null }),
    );
  }, [fileSearchOpen, hasSearchQuery, searchLoading, searchError, searchRoots, searchExpanded]);

  // The windowed tree rows: the tree, or a one-line note while it loads, errors or is empty.
  const treeDisplayRows = useMemo(() => {
    const rows: DisplayRow[] = [];
    if (loading) rows.push({ kind: "message", key: "tree-loading", text: t("files.loading") });
    else if (error) rows.push({ kind: "message", key: "tree-error", text: error, tone: "error" });
    else {
      for (const row of treeRows) rows.push({ kind: "tree", key: `t:${row.key}`, row, onToggle: handleToggleExpanded });
      if (treeRows.length === 0) rows.push({ kind: "message", key: "tree-none", text: t("files.noFiles") });
    }
    return rows;
  }, [loading, error, treeRows, t, handleToggleExpanded]);

  const treeOffsets = useMemo(() => {
    const result = new Array<number>(treeDisplayRows.length + 1);
    result[0] = 0;
    for (let index = 0; index < treeDisplayRows.length; index += 1) result[index + 1] = result[index] + displayRowHeight(treeDisplayRows[index]);
    return result;
  }, [treeDisplayRows]);

  // The windowed changed-files list: its stats header and one row per change.
  const changeDisplayRows = useMemo(() => {
    const rows: DisplayRow[] = [{ kind: "change-header", key: "change-header", count: gitFiles.length, additions: gitLineStats.additions, deletions: gitLineStats.deletions }];
    for (const status of gitFiles) rows.push({ kind: "change", key: `c:${status.filePath}`, status });
    return rows;
  }, [gitFiles, gitLineStats]);

  const searchActive = fileSearchOpen && hasSearchQuery;
  const treeActive = (changesCollapsed || gitFiles.length === 0) && !searchActive;
  const changedShown = !changesCollapsed && gitFiles.length > 0;

  const applyUploadResult = useCallback((data: UploadResponse, directory: string) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ directory, uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(directory, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
    directory: string,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(directory, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data, directory);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult]);

  const prepareUpload = useCallback(async (files: File[], directory: string) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(directory)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error", directory);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files, cwd);
  }, [cwd, prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
  }), [uploadBusy]);

  const resetFileDrag = useCallback(() => {
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    setDropTargetPath(null);
  }, []);

  const handleExplorerDragEnter = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  }, []);

  const handleExplorerDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    // Directory rows stop dragover propagation, so this handler only runs
    // while hovering the panel background: those uploads target the cwd.
    setDropTargetPath((prev) => (prev === null ? prev : null));
  }, []);

  const handleExplorerDragLeave = useCallback(() => {
    if (fileDragDepthRef.current <= 0) return;
    fileDragDepthRef.current -= 1;
    if (fileDragDepthRef.current === 0) {
      fileDragDepthRef.current = 0;
      setFileDragActive(false);
      setDropTargetPath(null);
    }
  }, []);

  const handleDropFiles = useCallback((directory: string, items: DroppedItem[]) => {
    resetFileDrag();
    // The endpoint writes files only: a dropped folder would fail the whole
    // upload, so folders are left out with the chat drop's notice.
    const files = items.flatMap((item) => (item.kind === "file" ? [item.file] : []));
    const folders = items.flatMap((item) => (item.kind === "folder" ? [item.name] : []));
    void prepareUpload(files, directory).then(() => {
      if (folders.length === 0) return;
      const notice = t("chat.dropFoldersUnsupported", { names: folders.join(", ") });
      // An error from this upload says why its files did not land: keep it.
      setUploadError((error) => (error && files.length > 0 ? error : notice));
    });
  }, [prepareUpload, resetFileDrag, t]);

  const handleDropTargetChange = useCallback((path: string | null) => {
    setDropTargetPath((prev) => (prev === path ? prev : path));
  }, []);

  const handleExplorerDrop = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    handleDropFiles(dropTargetPath ?? cwd, droppedItems(event.dataTransfer));
  }, [cwd, dropTargetPath, handleDropFiles]);

  // The rows read these at event time through a stable ref, so their memo is
  // not broken when a callback's own dependencies change.
  handlersRef.current = {
    onOpenFile,
    onAllowLink: handleAllowLink,
    onDropFiles: handleDropFiles,
    onDropTargetChange: handleDropTargetChange,
  };

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  // Declared before the cwd effect, so that one saves the set the user last saw.
  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  // An explorer that unmounts (its cwd gone, then back) saves its folder's set too, so it comes back open.
  useEffect(() => () => {
    if (prevCwdRef.current !== null) expandedPathsByCwd.save(prevCwdRef.current, expandedPathsRef.current);
  }, []);

  useEffect(() => {
    const previousCwd = prevCwdRef.current;
    const cwdChanged = previousCwd !== cwd;
    prevCwdRef.current = cwd;

    // Swap the open directories only when cwd changes, not on refreshKey bumps.
    // The roots unmount while the new cwd loads, so each restored directory
    // mounts open and lists itself; one that is gone is never listed to look.
    if (cwdChanged) {
      if (previousCwd !== null) expandedPathsByCwd.save(previousCwd, expandedPathsRef.current);
      const restored = expandedPathsByCwd.restore(cwd);
      expandedPathsRef.current = restored;
      setExpandedPaths(restored);
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setDirLoads(new Map());
      setAllowedLinkTargets(new Map());
      setLinkErrors(new Map());
      revealDoneRef.current = "";
    }

    setLoading(cwdChanged);
    setError(null);
    if (!treeVisible) {
      // Nothing has looked at the tree yet: keep it unlisted (and the previous
      // project's rows out of it) until the panel is shown.
      setRoots([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetchEntries(cwd, showHidden)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey, showHidden, treeVisible]);

  // A tree refresh (a run ended, the window refocused, an upload, the button)
  // or the ignored-files switch reloads every open directory and marks a
  // collapsed one to list again when it next opens.
  useEffect(() => {
    const rows = treeRowsRef.current;
    setDirLoads((prev) => {
      const next = new Map<string, DirLoad>();
      for (const row of rows) {
        if (!row.expanded) continue;
        const existing = prev.get(row.key);
        next.set(row.key, { children: existing?.children ?? null, loading: false, error: null });
      }
      return next;
    });
    for (const row of rows) {
      if (!row.expanded || row.pendingLink) continue;
      void loadDir(row.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, showHidden]);

  // List every open directory that has not been listed yet (or since its parent
  // listed), level by level as each parent's entries arrive.
  useEffect(() => {
    for (const row of treeRows) {
      if (!row.expanded || row.pendingLink) continue;
      const load = dirLoads.get(row.key);
      if (load && (load.loading || load.children !== null || load.error !== null)) continue;
      void loadDir(row.key);
    }
  }, [treeRows, dirLoads, loadDir]);

  // Files changed outside pi-web (an editor, a terminal) show up once the
  // window is back in front (#1144).
  useEffect(() => {
    const refresh = () => setTreeRefreshKey((key) => key + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  // Track the sidebar's own scroller: its scrollTop and height drive the
  // window, and the fixed content above the list (upload feedback, the search
  // box, the search results above the changed list) offsets where row 0 sits.
  // Measured on scroll, resize and whenever the content above it changes size.
  const scrollLayoutSignature = [
    uploadPhase,
    uploadSummary ? uploadSummary.uploaded.length + uploadSummary.skipped.length + uploadSummary.errors.length : -1,
    pendingConflict ? pendingConflict.conflicts.length : -1,
    uploadError ? 1 : 0,
    fileSearchOpen ? 1 : 0,
    searchActive && !searchLoading && !searchError ? searchRows.length : -1,
  ].join("|");
  useEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    const above = aboveRef.current;
    if (!root || !list) return;
    const scroller = root.closest(".sidebar-files-scroll") as HTMLElement | null;
    if (!scroller) return;
    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const offsetAbove = listRect.top - scrollerRect.top + scroller.scrollTop;
      const scrollTop = scroller.scrollTop;
      const viewportHeight = scroller.clientHeight;
      setScroll((prev) => (
        prev.scrollTop === scrollTop && prev.viewportHeight === viewportHeight && Math.abs(prev.offsetAbove - offsetAbove) < 0.5
          ? prev
          : { scrollTop, viewportHeight, offsetAbove }
      ));
    };
    measure();
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    if (above) observer?.observe(above);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollLayoutSignature]);

  // Bring a highlighted row (files just uploaded, or a path a message names)
  // into view once it is in the tree.
  useLayoutEffect(() => {
    if (!treeActive || highlightedPaths.size === 0) return;
    const root = rootRef.current;
    if (!root) return;
    const scroller = root.closest(".sidebar-files-scroll") as HTMLElement | null;
    if (!scroller || scroller.getClientRects().length === 0) return;
    const signature = [...highlightedPaths].sort().join("\n");
    if (revealDoneRef.current === signature) return;
    const index = treeDisplayRows.findIndex((row) => row.kind === "tree" && highlightedPaths.has(row.row.node.fullPath));
    if (index < 0) return;
    const next = revealScrollTop(treeOffsets, index, scroller.scrollTop, scroller.clientHeight);
    if (next !== null) scroller.scrollTop = scroll.offsetAbove + next;
    revealDoneRef.current = signature;
  }, [treeActive, treeDisplayRows, treeOffsets, highlightedPaths, scroll.offsetAbove]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(uploadSummary.directory, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  // One handler for every row, found from the event's own target: the tree, the
  // search results and the changed list all mark themselves with the path they
  // stand for. Right-clicking outside a row (the header keys, the upload area) is
  // left alone, so the browser's menu still appears there.
  const handleRowContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onRowMenu) return;
    const row = (event.target as HTMLElement | null)?.closest?.("[data-file-row-path]");
    const path = row?.getAttribute("data-file-row-path");
    if (!row || !path) return;
    // The browser's menu offers Copy and Save As on a name the reader was trying
    // to act on; this row has its own actions instead.
    event.preventDefault();
    const isDir = row.getAttribute("data-file-row-is-dir") === "true";
    onRowMenu(
      {
        path,
        relativePath: getRelativeFilePath(path, cwd),
        name: getFileName(path),
        isDir,
        // A directory's own row may stand for a submodule, whose revert is not a
        // file checkout, so only a file row brings its status along.
        gitStatus: isDir ? null : gitStatusByPath.get(normalizeFilePathSlashes(path)) ?? null,
      },
      { x: event.clientX, y: event.clientY },
    );
  }, [cwd, gitStatusByPath, onRowMenu]);

  return (
    <div
      ref={rootRef}
      style={{ minHeight: "100%" }}
      onContextMenu={handleRowContextMenu}
      onDragEnter={handleExplorerDragEnter}
      onDragOver={handleExplorerDragOver}
      onDragLeave={handleExplorerDragLeave}
      onDrop={handleExplorerDrop}
    >
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      <div ref={aboveRef}>
        {showUploadFeedback && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            {uploadBusy && (
              <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
                  {uploadPhase === "checking" ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                      <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 16V4" />
                      <path d="m7 9 5-5 5 5" />
                      <path d="M5 20h14" />
                    </svg>
                  )}
                  {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
                </div>
                {uploadPhase === "uploading" && (
                  <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                    <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
                  </div>
                )}
              </div>
            )}

            {pendingConflict && (
              <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
                <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
                </div>
                {pendingConflict.nonReplaceable.length > 0 && (
                  <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                    {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
                  </div>
                )}
                <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
                  <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                    {t("files.replace")}
                  </button>
                  <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                    {t("files.skipExisting")}
                  </button>
                  <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                    {t("files.cancel")}
                  </button>
                </div>
              </div>
            )}

            {uploadError && (
              <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
                <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
                <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
              </div>
            )}

            {uploadSummary && (
              <div aria-live="polite">
                <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
                  <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                    {uploadSummary.uploaded.length > 0 && (
                      <span title={t("files.uploadedCount", { count: uploadSummary.uploaded.length })} aria-label={t("files.uploadedCount", { count: uploadSummary.uploaded.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                        <span>{uploadSummary.uploaded.length}</span>
                      </span>
                    )}
                    {uploadSummary.skipped.length > 0 && (
                      <span title={t("files.skippedCount", { count: uploadSummary.skipped.length })} aria-label={t("files.skippedCount", { count: uploadSummary.skipped.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="9" />
                          <path d="M8 12h8" />
                        </svg>
                        <span>{uploadSummary.skipped.length}</span>
                      </span>
                    )}
                    {uploadSummary.errors.length > 0 && (
                      <span title={t("files.failedCount", { count: uploadSummary.errors.length })} aria-label={t("files.failedCount", { count: uploadSummary.errors.length })} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 3 2.5 20h19L12 3Z" />
                          <path d="M12 9v4" />
                          <path d="M12 17h.01" />
                        </svg>
                        <span>{uploadSummary.errors.length}</span>
                      </span>
                    )}
                  </div>
                  {uploadSummary.uploaded.length > 0 && onAtMentions && (
                    <button
                      type="button"
                      onClick={addUploadedFilesToChat}
                      title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                      aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                      style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                    >
                      <MentionIcon />
                      {t("files.mention")}
                    </button>
                  )}
                  <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
                </div>
                {uploadSummary.errors.map((item) => (
                  <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 8v5" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {fileSearchOpen && (
          <div style={{ padding: "2px 8px 6px" }}>
            <div style={{ position: "relative" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}>
                <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
              </svg>
              <input
                ref={searchInputRef}
                id="file-search-input"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // Handled here: the debug panel and other document listeners leave this Escape alone.
                  event.preventDefault();
                  onFileSearchOpenChange?.(false);
                }}
                placeholder={t("sidebar.searchFilesPlaceholder")}
                aria-label={t("sidebar.searchFiles")}
                style={{ width: "100%", boxSizing: "border-box", padding: "6px 24px", border: "1px solid var(--border)", borderRadius: 8, outline: "none", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  title={t("sidebar.clearSearch")}
                  aria-label={t("sidebar.clearSearch")}
                  style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The search results render in full: a query is capped at a handful of
          matches, so there is nothing to window. */}
      {searchActive && (
        <div style={{ padding: "3px 8px 6px" }}>
          {searchLoading && <div role="status" style={{ padding: "6px 2px", fontSize: 10, color: "var(--text-dim)" }}>{t("sidebar.searchingFiles")}</div>}
          {!searchLoading && searchError && <div role="alert" style={{ padding: "6px 2px", fontSize: 10, color: "#f87171" }}>{t("i18n.networkError")}</div>}
          {!searchLoading && !searchError && searchPaths.length === 0 && <div style={{ padding: "6px 2px", fontSize: 10, color: "var(--text-dim)" }}>{t("sidebar.noMatchingFiles")}</div>}
          {!searchLoading && !searchError && searchPaths.length > 0 && (
            <div>
              {searchRows.map((row) => (
                <div key={row.key}>{renderTreeRow(row, handleSearchToggle, { gitStatusByPath, changedDirectoryPaths, highlightedPaths, dropTargetPath }, handlersRef, t)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The changed-files list: windowed, since a large repository lists
          hundreds. Mutually exclusive with the tree below. */}
      {changedShown && (
        <div style={{ padding: "0 4px 2px" }}>
          <WindowedList
            rows={changeDisplayRows}
            scrollTop={scroll.scrollTop}
            viewportHeight={scroll.viewportHeight}
            offsetAbove={scroll.offsetAbove}
            gitStatusByPath={gitStatusByPath}
            changedDirectoryPaths={changedDirectoryPaths}
            highlightedPaths={highlightedPaths}
            dropTargetPath={dropTargetPath}
            handlers={handlersRef}
            cwd={cwd}
            t={t}
            listRef={listRef}
          />
        </div>
      )}

      {(changesCollapsed || gitFiles.length === 0) && (!fileSearchOpen || !hasSearchQuery) && (
        <div style={{ padding: "2px 4px" }}>
          <WindowedList
            rows={treeDisplayRows}
            scrollTop={scroll.scrollTop}
            viewportHeight={scroll.viewportHeight}
            offsetAbove={scroll.offsetAbove}
            gitStatusByPath={gitStatusByPath}
            changedDirectoryPaths={changedDirectoryPaths}
            highlightedPaths={highlightedPaths}
            dropTargetPath={dropTargetPath}
            handlers={handlersRef}
            cwd={cwd}
            t={t}
            listRef={listRef}
          />
        </div>
      )}

      {/* Last, pinned to the bottom: at the top it pushed every row down as
          a drag came in, so the row under the pointer changed. Drags pass
          through it to the row it covers. */}
      {fileDragActive && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "sticky",
            bottom: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 8px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            fontSize: 11,
            color: "var(--accent)",
            userSelect: "none",
            pointerEvents: "none",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M12 16V4" />
            <path d="m7 9 5-5 5 5" />
            <path d="M5 20h14" />
          </svg>
          {t("files.dropToUpload", {
            directory: dropTargetPath
              ? (getRelativeFilePath(dropTargetPath, cwd) || dropTargetPath)
              : (getFileName(cwd) || cwd),
          })}
        </div>
      )}
    </div>
  );
});
