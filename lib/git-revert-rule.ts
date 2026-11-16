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

/**
 * What a row's item does to its file: `restore` puts back the bytes HEAD already
 * holds, `delete` removes a file HEAD never held — that change only goes away with
 * the file. `null` is a change neither action covers.
 */
export type GitRevertAction = "restore" | "delete";

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
 * or deleted — every one of them content Git already has in HEAD.
 */
const RESTORE_CODES = new Set([" ", "M", "D"]);

/**
 * The action one changed file's row offers, read off its porcelain XY pair.
 * Untracked and staged-new files are deleted: HEAD holds no version of them, so
 * the change can only go away with the file. A rename, a copy, a conflict or a
 * type change has no action, and its row says nothing.
 */
export function gitRevertAction(
  status: Pick<GitFileStatus, "indexStatus" | "worktreeStatus">,
): GitRevertAction | null {
  const indexStatus = status.indexStatus;
  const worktreeStatus = status.worktreeStatus;
  if (indexStatus === "?" && worktreeStatus === "?") return "delete";
  // Staged for the first time, then edited or deleted from the working tree since:
  // the staged copy is the only version there is. `AU` is a conflict, not a delete.
  if (indexStatus === "A" && (worktreeStatus === " " || worktreeStatus === "M" || worktreeStatus === "D")) {
    return "delete";
  }
  if (!RESTORE_CODES.has(indexStatus) || !RESTORE_CODES.has(worktreeStatus)) return null;
  // An entry with neither side changed is not a change at all.
  return indexStatus !== " " || worktreeStatus !== " " ? "restore" : null;
}
