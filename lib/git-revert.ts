import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { getGitStatus, isWithinPath, toGitPath } from "./git-changes";
import { invalidateGitStatusCache } from "./git-status-cache";
import { resolveExistingPath } from "./paths";
import { isGitPathRevertible, type GitRevertRefusal } from "./git-revert-rule";

/**
 * Reverting one file of a working tree, from the file row's right-click menu.
 * Server side only: this is the one place Pi Web runs Git in a way that writes.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export interface GitReverted {
  reverted: true;
  /** The path as the repository lists it, resolved against the repository root. */
  filePath: string;
}

export interface GitRevertRefused {
  reverted: false;
  code: GitRevertRefusal;
  /** Git's own words for `failed`; the client shows its own sentence for the rest. */
  error: string;
}

export type GitRevertResult = GitReverted | GitRevertRefused;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (text) return text;
  return error instanceof Error ? error.message : String(error);
}

function refuse(code: GitRevertRefusal, error = ""): GitRevertRefused {
  return { reverted: false, code, error };
}

/**
 * A pathspec that matches exactly this one path: a name holding `*`, `?` or `[`
 * would otherwise reach the other files its glob matches, and a leading `:` is
 * pathspec magic rather than a file.
 */
function literalPathspec(gitPath: string): string {
  return `:(literal)${gitPath}`;
}

/**
 * One path with every symlink in it that exists resolved (lib/paths.ts), kept here
 * under the name this module's checks read.
 */
const resolveExisting = resolveExistingPath;

function samePath(a: string, b: string): boolean {
  return resolveExisting(a) === resolveExisting(b);
}

/** What sits at the path now: a regular file or nothing, never a directory or a link. */
function isRevertibleTargetOnDisk(filePath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    // A tracked file the working tree no longer has is a change worth reverting.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return stat.isFile();
}

/**
 * Puts one file back to HEAD: its bytes in the working tree and its entry in the
 * index, so a staged change is unstaged by the same command that writes the file.
 *
 * Refused rather than approximated when the file is untracked, newly added,
 * renamed, copied or in conflict (see lib/git-revert-rule.ts): what HEAD lacks
 * there is not a previous version to go back to, and the revert would delete
 * something Git never stored.
 */
export async function revertGitPath(cwd: string, filePath: string): Promise<GitRevertResult> {
  const status = await getGitStatus(cwd);
  const repositoryRoot = status.repositoryRoot;
  if (!status.isGitRepository || !repositoryRoot) {
    return refuse("not_git", "Not a Git repository");
  }
  const target = path.resolve(filePath);
  const resolvedRoot = resolveExisting(repositoryRoot);
  const resolvedTarget = resolveExisting(target);
  // The repository's real name and the target are what must lie one inside the other:
  // the caller may have reached the repository through a link, and a link inside a
  // working tree can otherwise lead the checkout outside it.
  if (!isWithinPath(resolvedRoot, resolvedTarget)) {
    return refuse("outside_repository", `${filePath} is outside ${repositoryRoot}`);
  }

  const entry = status.files.find((file) => samePath(file.filePath, target));
  if (!entry) return refuse("no_changes", "This file has no Git changes");
  if (!isGitPathRevertible(entry)) {
    return refuse("not_revertible", `A ${entry.status} file cannot be reverted`);
  }
  if (!isRevertibleTargetOnDisk(entry.filePath)) {
    // A submodule checkout, or a file that became a link or a socket since the status read.
    return refuse("not_revertible", `${entry.filePath} is not a file`);
  }

  // The status lists its paths with the caller's own prefix (lib/git-changes.ts), so the
  // path Git is given comes from the resolved pair, not from that prefix.
  const relativePath = toGitPath(path.relative(resolvedRoot, resolvedTarget));
  if (!relativePath || relativePath === ".git" || relativePath.startsWith(".git/")) {
    return refuse("outside_repository", `${filePath} is inside the Git directory`);
  }

  try {
    // A repository with no commit has nothing to revert to; say so instead of
    // letting the checkout fail with `invalid reference: HEAD`.
    await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return refuse("no_commits", "This repository has no commits");
  }

  try {
    // `checkout <commit> -- <path>` writes both the index and the working tree,
    // which is why one command covers a staged, an unstaged and a split change.
    await git(repositoryRoot, ["checkout", "HEAD", "--", literalPathspec(relativePath)]);
  } catch (error) {
    return refuse("failed", gitErrorText(error));
  }

  // The listing the caller refetches after a revert must not be the one cached
  // before the checkout.
  invalidateGitStatusCache();
  return { reverted: true, filePath: entry.filePath };
}
