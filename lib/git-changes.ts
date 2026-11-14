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
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "") || null;
  } catch {
    return null;
  }
}

export function isWithinPath(parent: string, target: string): boolean {
  return isRelativeWithin(path.relative(path.resolve(parent), path.resolve(target)));
}

/** Whether a `path.relative()` answer stays inside the folder it was taken from. */
function isRelativeWithin(relative: string): boolean {
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(
  repositoryRoot: string,
  gitConfig: readonly string[] = [],
): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    ...gitConfig,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

/**
 * The line stats of the tracked changes under `cwd`. Git reports the paths relative
 * to the repository root however it is asked, and `-- .` from the folder itself
 * covers the same files as the root with that folder's path, so this asks the
 * folder and runs beside the repository root lookup rather than after it.
 */
async function readTrackedLineStats(
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  try {
    const output = await git(cwd, [
      "--literal-pathspecs",
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

const STATUS_ENTRIES_PER_TURN = 1000;
// libuv's default thread pool: more reads only queue in front of the server's other fs work.
const UNTRACKED_READ_CONCURRENCY = 4;
const UNTRACKED_READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/**
 * An untracked text file's lines as a new-file diff counts them: one per "\n", plus
 * one for a last line without it. Empty, binary (a NUL byte), larger than the text
 * preview, and anything but a regular file count 0. Read in chunks into `buffer`,
 * up to the size lstat reported, as readFileSync read up to the size it found.
 * A file whose size, times and inode a quiet previous scan counted is not read
 * again while they still say the same.
 */
async function countUntrackedTextLines(filePath: string, buffer: Buffer): Promise<number> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES || stat.size === 0) return 0;
    const remembered = untrackedLineCounts.get(filePath);
    if (
      remembered
      && remembered.size === stat.size
      && remembered.mtimeMs === stat.mtimeMs
      && remembered.ctimeMs === stat.ctimeMs
      && remembered.ino === stat.ino
    ) {
      // A remembered file stays in the map, and moves to its end.
      untrackedLineCounts.delete(filePath);
      untrackedLineCounts.set(filePath, remembered);
      return remembered.lines;
    }
    const handle = await fs.promises.open(filePath, "r");
    let lines: number;
    try {
      let total = 0;
      let newlines = 0;
      let lastByte = -1;
      while (total < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - total), null);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (hasNullByte(chunk)) return 0;
        for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, index + 1)) newlines++;
        lastByte = chunk[bytesRead - 1];
        total += bytesRead;
      }
      if (total === 0) return 0;
      lines = lastByte === NEWLINE ? newlines : newlines + 1;
    } finally {
      await handle.close();
    }
    // Only a file that has been quiet for a while is remembered: a change to it
    // after this point carries a later stamp, and is therefore seen.
    if (Date.now() - stat.ctimeMs >= RECENT_FILE_MS) {
      untrackedLineCounts.set(filePath, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
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

/**
 * The lines an untracked file holds, remembered while the file is unchanged. A
 * file's size, times and inode say whether its bytes are the ones that were
 * counted, so an unchanged file is not read again on the next scan. The listing
 * itself is never remembered: it is read from Git on every request.
 */
interface UntrackedLineCount {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
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

// Async and a few files at a time: tens of thousands of untracked files read
// synchronously held the server's event loop, every stream and request, for
// seconds (#1584). Same counts, and a file nothing has touched since is not read
// again. Stops when the request is gone.
async function countUntrackedLines(filePaths: readonly string[], signal?: AbortSignal): Promise<number> {
  let next = 0;
  let total = 0;
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(UNTRACKED_READ_CHUNK_BYTES);
    while (next < filePaths.length && !signal?.aborted) {
      const lines = await countUntrackedTextLines(filePaths[next++], buffer);
      total += lines;
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_READ_CONCURRENCY, filePaths.length) }, worker));
  return total;
}

/** `signal`: the request's; once it aborts the scan stops and this throws. */
export async function getGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
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

  // Git names the repository by its real path, while the cwd may reach it through a
  // link (`/tmp` and `/var/folders/…` are links on macOS): compare real paths, and
  // report each file under the cwd as given, the way the file tree lists it.
  const realRoot = resolveExistingPath(repositoryRoot);
  const realCwd = resolveExistingPath(cwd);
  const files: GitFileStatus[] = [];
  for (let index = 0; index < entries.length; index++) {
    // Tens of thousands of paths take long enough to stall the server on their own.
    if (index > 0 && index % STATUS_ENTRIES_PER_TURN === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    const entry = entries[index];
    const relative = path.relative(realCwd, path.resolve(realRoot, entry.path));
    if (!isRelativeWithin(relative)) continue;
    files.push({
      filePath: path.join(cwd, relative),
      ...classifyGitStatus(entry),
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    });
  }
  const untrackedAdditions = await countUntrackedLines(
    files.flatMap((file) => (file.status === "untracked" ? [file.filePath] : [])),
    signal,
  );
  signal?.throwIfAborted();

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
  if (content.length === 0) return "";
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
      "--literal-pathspecs",
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
  // Git names the repository by its real path, while the file and the cwd may be named
  // through a link: compare real paths. A file whose real path leaves the repository
  // stays out; the route has already checked that real path against the allowed roots.
  const realRoot = resolveExistingPath(repositoryRoot);
  const realFilePath = resolveExistingPath(filePath);
  if (!isWithinPath(realRoot, realFilePath)) return { supported: false };
  // Reading the index runs a repository-configured fsmonitor hook. Opening a
  // file in another checkout (one nested in the cwd, say) must not run its hook,
  // as expanding that folder in the file tree does not (lib/file-tree-visibility.ts);
  // the cwd's own repository keeps its fsmonitor.
  const gitConfig = isWithinPath(realRoot, resolveExistingPath(cwd)) ? [] : ["-c", "core.fsmonitor=false"];

  const resolvedFilePath = path.resolve(filePath);
  const relativePath = toGitPath(path.relative(realRoot, realFilePath));
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
