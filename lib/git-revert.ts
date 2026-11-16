import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { getGitStatus, isWithinPath, toGitPath } from "./git-changes";
import { resolveExistingPath } from "./paths";
import { gitRevertAction, type GitRevertRefusal, type GitRevertAction } from "./git-revert-rule";
import type { GitFileStatus } from "./git-types";

/**
 * Reverting the changes of one file — or of every changed file under a folder —
 * from the file row's right-click menu. Server side only: this is the one place
 * Pi Web runs Git in a way that writes.
 */

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
// One write prints a line per file it touched, and a folder can hold thousands.
const WRITE_MAX_BUFFER = 16 * 1024 * 1024;
// More paths than a command line has room for go one command per chunk, run one
// after another so two writes never hold the index at once.
const PATHS_PER_COMMAND = 400;

export interface GitReverted {
  reverted: true;
  /** The path the request named, as the repository lists it. */
  filePath: string;
  /** How many files the action covered: a folder's whole listing, a file's one. */
  count: number;
}

export interface GitRevertRefused {
  reverted: false;
  code: GitRevertRefusal;
  /** Git's own words for `failed`; the client shows its own sentence for the rest. */
  error: string;
}

export type GitRevertResult = GitReverted | GitRevertRefused;

async function git(cwd: string, args: string[], maxBuffer = 64 * 1024): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
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

/** Whether the path is a directory itself, never through a link to one. */
function isDirectoryOnDisk(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/** Whether a listed file lies strictly inside the folder, by resolved real paths. */
function isInsideFolder(filePath: string, resolvedFolder: string): boolean {
  const resolvedFile = resolveExisting(filePath);
  return resolvedFile !== resolvedFolder && isWithinPath(resolvedFolder, resolvedFile);
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

/** The repo-relative, slash-separated path Git is given for one listed file. */
function gitPathFor(resolvedRoot: string, filePath: string): string {
  return toGitPath(path.relative(resolvedRoot, resolveExisting(filePath)));
}

/** A literal pathspec per file, each naming exactly its own path. */
function pathspecsFor(resolvedRoot: string, files: readonly GitFileStatus[]): string[] {
  return files.map((file) => literalPathspec(gitPathFor(resolvedRoot, file.filePath)));
}

/** One Git command per chunk of pathspecs, in order, so the index is written by one at a time. */
async function gitPaths(repositoryRoot: string, args: string[], specs: string[]): Promise<void> {
  for (let index = 0; index < specs.length; index += PATHS_PER_COMMAND) {
    await git(repositoryRoot, [...args, ...specs.slice(index, index + PATHS_PER_COMMAND)], WRITE_MAX_BUFFER);
  }
}

/**
 * The delete half of the write: a file HEAD never held goes away from the working
 * tree, and a staged one from the index with it. `rm` takes the index entry with
 * the file, `clean` has none to take.
 */
async function deletePaths(
  repositoryRoot: string,
  resolvedRoot: string,
  files: readonly GitFileStatus[],
): Promise<void> {
  const staged = files.filter((file) => file.indexStatus === "A");
  const untracked = files.filter((file) => file.indexStatus === "?");
  if (staged.length > 0) {
    await gitPaths(repositoryRoot, ["rm", "-f", "--"], pathspecsFor(resolvedRoot, staged));
  }
  if (untracked.length === 0) return;
  await gitPaths(repositoryRoot, ["clean", "-f", "--"], pathspecsFor(resolvedRoot, untracked));
  // `clean` says nothing when a pathspec matches nothing, so a file another window
  // took between the status read and this one would read as deleted. Say so instead.
  const survivor = untracked.find((file) => fs.existsSync(file.filePath));
  if (survivor) throw new Error(`${survivor.filePath} was not removed`);
}

/**
 * Puts one changed file back to HEAD, or takes away every changed file under a
 * folder: bytes in the working tree and the entry in the index, so a staged
 * change is unstaged by the same command that writes the file. A file HEAD never
 * held is deleted instead; the action per file is lib/git-revert-rule.ts.
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
  const relativeTarget = toGitPath(path.relative(resolvedRoot, resolvedTarget));
  if (!relativeTarget || relativeTarget === ".git" || relativeTarget.startsWith(".git/")) {
    return refuse("outside_repository", `${filePath} is inside the Git directory`);
  }

  // A folder's revert is every changed file under it; a file's is its own entry.
  const folder = isDirectoryOnDisk(target);
  const entries = folder
    ? status.files.filter((file) => isInsideFolder(file.filePath, resolvedTarget))
    : status.files.filter((file) => samePath(file.filePath, target));
  // Each file carries its own action, and a path that is neither a regular file nor
  // absent — a submodule checkout, a file that became a link — is left out of both.
  const targets: { file: GitFileStatus; action: GitRevertAction }[] = [];
  for (const file of entries) {
    const action = gitRevertAction(file);
    if (action !== null && isRevertibleTargetOnDisk(file.filePath)) targets.push({ file, action });
  }
  if (targets.length === 0) {
    // No entry at all is a path Git lists nothing for; an entry with no action is a
    // rename, a copy, a conflict or a type change.
    return refuse(entries.length === 0 ? "no_changes" : "not_revertible",
      folder ? `Nothing under ${filePath} can be reverted` : "This change cannot be reverted");
  }
  const restores = targets.filter((candidate) => candidate.action === "restore");
  const deletes = targets.filter((candidate) => candidate.action === "delete");

  try {
    // A repository with no commit has nothing to revert to; say so instead of
    // letting the checkout fail with `invalid reference: HEAD`. A file HEAD never
    // held is only deleted, and a repository without commits still has those.
    if (restores.length > 0) {
      await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    }
  } catch {
    return refuse("no_commits", "This repository has no commits");
  }

  try {
    // `checkout <commit> -- <path>` writes both the index and the working tree,
    // which is why one command covers a staged, an unstaged and a split change.
    if (restores.length > 0) {
      await gitPaths(repositoryRoot, ["checkout", "HEAD", "--"], pathspecsFor(resolvedRoot, restores.map((one) => one.file)));
    }
    if (deletes.length > 0) {
      await deletePaths(repositoryRoot, resolvedRoot, deletes.map((one) => one.file));
    }
  } catch (error) {
    return refuse("failed", gitErrorText(error));
  }

  return {
    reverted: true,
    filePath: folder ? target : targets[0].file.filePath,
    count: targets.length,
  };
}
