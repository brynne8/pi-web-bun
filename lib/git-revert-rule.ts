import type { GitFileStatus } from "./git-types";

/**
 * Which changed files the file row's Revert offers, and why the others are left
 * alone. Client-safe: the sidebar menu reads it as well as the server that runs
 * the revert, so the item and the refusal never disagree.
 */

/**
 * Why a revert was refused.
 *
 * `no_changes` and `not_revertible` are the two a reader can reach by being slow:
 * the row said the file was revertible, another window (or a `git add`) moved it
 * before the click arrived.
 */
export type GitRevertRefusal =
  | "not_git"
  | "outside_repository"
  | "no_commits"
  | "no_changes"
  | "not_revertible"
  | "failed";

/** What the sidebar's toast says for each refusal. `{error}` is Git's own words. */
export const GIT_REVERT_REFUSAL_KEYS: Record<GitRevertRefusal, string> = {
  not_git: "files.revertNotGit",
  outside_repository: "files.revertOutside",
  no_commits: "files.revertNoCommits",
  no_changes: "files.revertNoChanges",
  not_revertible: "files.revertNotRevertible",
  failed: "files.revertFailed",
};

/**
 * `git status --porcelain` X/Y codes a revert can bring back: untouched, modified
 * or deleted — every one of them content Git already has in HEAD. The codes left
 * out are ones whose "change" is something HEAD never held, where a revert would
 * delete something rather than restore it; the reason per code is in
 * `docs/agents/files-and-access.md`.
 */
const REVERTIBLE_CODES = new Set([" ", "M", "D"]);

/**
 * True when reverting this file only puts back what Git already stored: it
 * unstages the file and writes HEAD's bytes over the working tree, so the change
 * goes away whether it was staged, unstaged or both.
 */
export function isGitPathRevertible(
  status: Pick<GitFileStatus, "indexStatus" | "worktreeStatus">,
): boolean {
  const indexStatus = status.indexStatus;
  const worktreeStatus = status.worktreeStatus;
  if (!REVERTIBLE_CODES.has(indexStatus) || !REVERTIBLE_CODES.has(worktreeStatus)) return false;
  // An entry with neither side changed is not a change at all.
  return indexStatus !== " " || worktreeStatus !== " ";
}
