import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";
import { resolveExistingPath } from "./paths";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

export function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(
  directory: string,
  gitConfig: readonly string[] = [],
): Promise<GitPorcelainEntry[]> {
  const output = await git(directory, [
    ...gitConfig,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

/**
 * The line stats of the tracked changes under `cwd`. Git reports the paths
 * relative to the repository root however it is asked, and `-- .` from the
 * folder itself covers the same files as the root with that folder's path.
 */
async function readTrackedLineStats(
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  try {
    const output = await git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      ".",
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

/**
 * The lines an untracked file holds, remembered while the file is unchanged.
 * A file's size, times and inode say whether its bytes are the ones that were
 * counted, so an unchanged file is not read again on the next scan. The
 * listing itself is never remembered: it is read from Git on every request.
 */
interface UntrackedLineCount {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  lines: number;
}

const untrackedLineCounts = new Map<string, UntrackedLineCount>();
const MAX_UNTRACKED_LINE_COUNTS = 2048;
// A file is only remembered, and a remembered file only trusted, while it has
// been quiet for this long: a filesystem with coarse timestamps (a second, or
// two) can leave a rewritten file's times where they were, and a file's own
// change time is the signal, since a program cannot set it back. The window is
// the coarsest stamp a filesystem reports, so a later change always shows up.
const RECENT_FILE_MS = 2_000;

function countUntrackedTextLines(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(TEXT_PREVIEW_MAX_BYTES)) return 0;
    const remembered = untrackedLineCounts.get(filePath);
    if (
      remembered
      && remembered.size === stat.size
      && remembered.mtimeNs === stat.mtimeNs
      && remembered.ctimeNs === stat.ctimeNs
      && remembered.ino === stat.ino
    ) {
      // A remembered file stays in the map, and moves to its end.
      untrackedLineCounts.delete(filePath);
      untrackedLineCounts.set(filePath, remembered);
      return remembered.lines;
    }
    const content = fs.readFileSync(filePath);
    if (hasNullByte(content) || content.length === 0) return 0;
    // The lines of a text file are its newlines, and a last line without one
    // counts as a line of its own.
    let newlines = 0;
    for (let i = 0; i < content.length; i++) if (content[i] === 10) newlines++;
    const lines = content[content.length - 1] === 10 ? newlines : newlines + 1;
    // Only a file that has been quiet for a while is remembered: a change to it
    // after this point carries a later stamp, and is therefore seen.
    if (Date.now() - Number(stat.ctimeNs) / 1e6 >= RECENT_FILE_MS) {
      untrackedLineCounts.set(filePath, {
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
        ino: stat.ino,
        lines,
      });
      while (untrackedLineCounts.size > MAX_UNTRACKED_LINE_COUNTS) {
        const oldest = untrackedLineCounts.keys().next().value;
        if (oldest === undefined) break;
        untrackedLineCounts.delete(oldest);
      }
    }
    return lines;
  } catch {
    return 0;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  // The three Git commands do not depend on each other, so they run at once:
  // the repository root, the status listing and the line stats of the tracked
  // changes. Git names its paths by the repository root however it is asked, so
  // asking from the folder itself answers what asking from the root does.
  const [repositoryRoot, statusResult, trackedLineStats] = await Promise.all([
    findRepositoryRoot(cwd),
    readStatusEntries(cwd).then(
      (entries) => ({ entries }),
      (error: unknown) => ({ error }),
    ),
    readTrackedLineStats(cwd),
  ]);
  if (!repositoryRoot) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }
  if ("error" in statusResult) throw statusResult.error;
  const entries = statusResult.entries;
  // Git names the repository by its real path, while the caller's cwd may reach
  // it through a link (`/tmp` and `/var/folders/…` are links on macOS). Every
  // path reported here is therefore rebased onto the cwd as given: the file tree
  // lists what it was given, and a row carries its change only if the two spell
  // the path alike; `repositoryRoot` stays Git's name, the repository's own.
  const resolvedCwd = resolveExistingPath(cwd);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const relativeToCwd = path.relative(resolvedCwd, path.resolve(repositoryRoot, entry.path));
    if (!relativeToCwd || relativeToCwd === ".." || relativeToCwd.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToCwd)) return [];
    const filePath = path.join(cwd, relativeToCwd);
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });
  const untrackedAdditions = files.reduce(
    (total, file) => total + (file.status === "untracked" ? countUntrackedTextLines(file.filePath) : 0),
    0,
  );

  return {
    isGitRepository: true,
    repositoryRoot,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
  gitConfig: readonly string[] = [],
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      ...gitConfig,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

// The file's own repository, not the cwd's: a session may start in a plain folder
// holding several repositories. A deleted file's folder may be gone too, so start
// from its nearest existing ancestor; fall back to the cwd.
async function findFileRepositoryRoot(cwd: string, filePath: string): Promise<string | null> {
  let directory = path.dirname(path.resolve(filePath));
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return (await findRepositoryRoot(directory)) ?? (await findRepositoryRoot(cwd));
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findFileRepositoryRoot(cwd, filePath);
  if (!repositoryRoot) return { supported: false };
  // Compared with links resolved: the file may have been named through a link the
  // repository's own name does not carry (see getGitStatus).
  const resolvedRoot = resolveExistingPath(repositoryRoot);
  const resolvedFilePath = resolveExistingPath(filePath);
  if (!isWithinPath(resolvedRoot, resolvedFilePath)) return { supported: false };
  // Reading the index runs a repository-configured fsmonitor hook. Opening a
  // file in another checkout (one nested in the cwd, say) must not run its hook,
  // as expanding that folder in the file tree does not (lib/file-tree-visibility.ts);
  // the cwd's own repository keeps its fsmonitor.
  const gitConfig = isWithinPath(resolvedRoot, resolveExistingPath(cwd)) ? [] : ["-c", "core.fsmonitor=false"];

  const relativePath = toGitPath(path.relative(resolvedRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot, gitConfig);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath, gitConfig);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath, gitConfig);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
