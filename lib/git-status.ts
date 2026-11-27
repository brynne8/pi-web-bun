import type { GitFileStatus, GitFileStatusKind } from "./git-types.ts";

export interface GitPorcelainEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

function usesRenamePath(indexStatus: string, worktreeStatus: string): boolean {
  return indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
}

export function parseGitPorcelainV1(output: string): GitPorcelainEntry[] {
  const records = output.split("\0");
  const entries: GitPorcelainEntry[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4 || record[2] !== " ") continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const entry: GitPorcelainEntry = {
      path: record.slice(3),
      indexStatus,
      worktreeStatus,
    };
    if (usesRenamePath(indexStatus, worktreeStatus)) {
      entry.originalPath = records[++i] || undefined;
    }
    entries.push(entry);
  }

  return entries;
}

/** What Git's index holds for one path against HEAD, or `U` when it is unmerged. */
export interface IndexChange {
  code: string;
  originalPath?: string;
}

/**
 * Parses `git diff --cached --name-status -z HEAD`, one record per path the index changed
 * against HEAD: `code NUL path NUL`, where a rename or copy names the path it came from
 * before its own. An unmerged path reports `U`, and nothing here reads the work tree.
 */
export function parseNameStatusZ(output: string): Map<string, IndexChange> {
  const records = output.split("\0");
  const changes = new Map<string, IndexChange>();
  for (let i = 0; i < records.length;) {
    const code = records[i];
    if (!code) {
      i += 1;
      continue;
    }
    const paired = code[0] === "R" || code[0] === "C";
    const originalPath = paired ? records[i + 1] : undefined;
    const path = paired ? records[i + 2] : records[i + 1];
    if (path) {
      changes.set(path, originalPath ? { code: code[0], originalPath } : { code: code[0] });
    }
    i += paired ? 3 : 2;
  }
  return changes;
}

/** How far the caller goes for a file's diff: Git's own diff of the path, that diff naming
 *  also the path a rename came from, or the file's bytes as a new file. */
export type FileDiffSource = "patch" | "rename-patch" | "content";

export interface FileDiffFacts {
  /** `git diff HEAD -- <path>`, or null when Git could not compare at all (no commits yet). */
  headDiff: string | null;
  /** What the index changed for this path; undefined when it staged nothing. */
  indexChange?: IndexChange;
  /** The index question answered, so HEAD exists to compare it with. */
  comparedWithHead: boolean;
  /** Git's index holds the path. null: the question failed, so nothing is known. */
  inIndex: boolean | null;
  /** Git's ignore rules cover the path, which no changed listing shows. null: it failed. */
  ignored: boolean | null;
  /** Something is there to read: the path exists, as a file within the preview's cap. */
  onDisk: boolean;
}

/**
 * One file's status from questions that name only that file, in classifyGitStatus()'s
 * precedence. Git's diff of the path stands for the work tree's side of the pair, and
 * holds only tracked content: an untracked or ignored path is never in it, so a change
 * already shown there needs no further question about the index.
 */
export function classifyFileDiff(facts: FileDiffFacts): { status: GitFileStatusKind; source: FileDiffSource } | null {
  const { headDiff, indexChange, comparedWithHead, inIndex, ignored, onDisk } = facts;
  const code = indexChange?.code;
  const differs = headDiff !== null && headDiff.trim() !== "";
  const shown = differs ? { status: "modified" as const, source: "patch" as const } : null;
  const deleted = headDiff !== null && headDiff.includes("\ndeleted file mode ");
  const created = headDiff !== null && headDiff.includes("\nnew file mode ");

  if (code === "U") return differs ? { status: "conflict", source: "patch" } : null;
  if (deleted || code === "D") return differs ? { status: "deleted", source: "patch" } : null;
  if (code === "R" || code === "C") {
    const source: FileDiffSource = indexChange?.originalPath ? "rename-patch" : "patch";
    // A rename whose destination is gone is the deletion the reader sees, as it was.
    if (!onDisk) return { status: "deleted", source };
    return { status: "renamed", source };
  }
  if (inIndex === null) return shown;
  if (!inIndex) return ignored === null ? shown : ignored ? null : { status: "untracked", source: "content" };
  // HEAD does not hold the path, which is what a new file in Git's own diff says. An entry
  // the index holds without its content (`git add -N`) stages no change at all, so that
  // header is the only place such an added file appears.
  if (code === "A" || created) {
    return headDiff === null
      ? { status: "added", source: "content" }
      : { status: "added", source: "patch" };
  }
  // A repository without commits has no HEAD for Git to name the index against, and an
  // index entry there is a file HEAD never held: its own bytes are all there is to show.
  if (!comparedWithHead && headDiff === null) return { status: "added", source: "content" };
  return shown;
}

const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function classifyGitStatus(entry: GitPorcelainEntry): Pick<GitFileStatus, "status" | "code"> {
  const pair = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (pair === "??") return { status: "untracked", code: "U" };
  if (CONFLICT_STATUSES.has(pair) || pair.includes("U")) return { status: "conflict", code: "C" };
  if (pair.includes("D")) return { status: "deleted", code: "D" };
  if (pair.includes("R") || pair.includes("C")) return { status: "renamed", code: "R" };
  if (pair.includes("A")) return { status: "added", code: "A" };
  return { status: "modified", code: "M" };
}
