import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { getGitStatus, isWithinPath, toGitPath } from "./git-changes";
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
 * One path with every symlink in it that exists resolved, so a repository reached
 * through a link (`/tmp` on macOS is one) still names the file Git names. The
 * nearest existing entry is resolved because a deleted file has nothing of its own.
 */
function resolveExisting(target: string): string {
  const absolute = path.resolve(target);
  let candidate = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(candidate), path.relative(candidate, absolute));
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) return absolute;
      candidate = parent;
    }
  }
}

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
  // Both the plain path and the resolved one must stay inside the repository: a
  // link inside a working tree can otherwise lead the checkout outside it.
  if (!isWithinPath(repositoryRoot, target)
    || !isWithinPath(resolveExisting(repositoryRoot), resolveExisting(target))) {
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

  const relativePath = toGitPath(path.relative(repositoryRoot, entry.filePath));
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

  return { reverted: true, filePath: entry.filePath };
}
