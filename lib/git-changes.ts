import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types.ts";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types.ts";
import {
  classifyFileDiff,
  classifyGitStatus,
  parseGitPorcelainV1,
  parseNameStatusZ,
  type GitPorcelainEntry,
  type IndexChange,
} from "./git-status.ts";
import { projectGitEnvironment } from "./git-environment.ts";
import { resolveExistingPath } from "./paths.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: projectGitEnvironment(),
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
async function countUntrackedTextLines(filePath: string, buffer: Buffer, recentFileMs: number): Promise<number> {
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
    if (Date.now() - stat.ctimeMs >= recentFileMs) {
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
async function countUntrackedLines(filePaths: readonly string[], signal: AbortSignal | undefined, recentFileMs: number): Promise<number> {
  let next = 0;
  let total = 0;
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(UNTRACKED_READ_CHUNK_BYTES);
    while (next < filePaths.length && !signal?.aborted) {
      const lines = await countUntrackedTextLines(filePaths[next++], buffer, recentFileMs);
      total += lines;
    }
  };
  await Promise.all(Array.from({ length: Math.min(UNTRACKED_READ_CONCURRENCY, filePaths.length) }, worker));
  return total;
}

/**
 * `signal`: the request's; once it aborts the scan stops and this throws.
 * `recentFileMs`: the quiet window before an untracked file's line count is remembered. A test
 * shortens it rather than sleeping it out; a route leaves it alone.
 */
export async function getGitStatus(cwd: string, signal?: AbortSignal, recentFileMs: number = RECENT_FILE_MS): Promise<GitStatusResponse> {
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
    recentFileMs,
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
      // A conversion filter a repository configures (`*.pdf diff=pdf`) would run on the file
      // behind the click and print something that is not the file. The raw bytes decide, and
      // Git calls a binary file's diff binary, which this route answers with nothing.
      "--no-textconv",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

/**
 * What the index holds for every path against HEAD, so a rename can be named with the path
 * it came from. This reads the index and the trees, never the work tree: a whole `git status`
 * stats every file in the repository, which is the cost one file's diff must not pay.
 */
async function readIndexChanges(
  repositoryRoot: string,
  gitConfig: readonly string[],
): Promise<Map<string, IndexChange> | null> {
  try {
    const output = await git(repositoryRoot, [
      ...gitConfig,
      "diff",
      "--cached",
      "-M",
      "--name-status",
      "-z",
      "HEAD",
    ]);
    return parseNameStatusZ(output);
  } catch {
    // A repository without commits has no HEAD, and a git that failed answers nothing.
    return null;
  }
}

/** Whether Git's index holds the path; an unmerged path answers with one line per stage. */
async function readPathInIndex(
  repositoryRoot: string,
  relativePath: string,
  gitConfig: readonly string[],
): Promise<boolean | null> {
  try {
    const output = await git(repositoryRoot, [
      ...gitConfig,
      "--literal-pathspecs",
      "ls-files",
      "-z",
      "--",
      relativePath,
    ]);
    return output.length > 0;
  } catch {
    return null;
  }
}

/**
 * Whether Git's ignore rules cover the path, which is what no changed listing shows and so
 * nothing shows here either. `check-ignore` exits 1 for "not ignored", which is an answer
 * rather than a failure; it consults the index, so a tracked path is never called ignored.
 */
async function readPathIgnored(
  repositoryRoot: string,
  relativePath: string,
  gitConfig: readonly string[],
): Promise<boolean | null> {
  try {
    await git(repositoryRoot, [...gitConfig, "check-ignore", "-q", "--", relativePath]);
    return true;
  } catch (error) {
    return gitExitCode(error) === 1 ? false : null;
  }
}

/** The exit code of a git run that ended non-zero; undefined when it never ran or was killed. */
function gitExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * The text of the file a diff is asked for, or null when it cannot be read or holds a NUL
 * anywhere: content no source view shows. Git calls a file binary by its first bytes alone,
 * so reading the file is the wider rule, and it is what kept a configured conversion filter
 * from running behind a click before this route stopped reading files at all.
 */
async function readDiffableFileText(filePath: string): Promise<string | null> {
  const buffer = await fs.promises.readFile(filePath).catch(() => null);
  if (!buffer || hasNullByte(buffer)) return null;
  return buffer.toString("utf8");
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
  // A path that is not a file, or one past the preview's cap, has no diff to show. A
  // deleted file has no stat at all and is answered from its patch, as it always was.
  const onDisk = await fs.promises.lstat(resolvedFilePath).catch(() => null);
  if (onDisk && (!onDisk.isFile() || onDisk.size > TEXT_PREVIEW_MAX_BYTES)) return { supported: false };

  // Five questions about this one path, asked at once, none of which reads the rest of the
  // work tree. The listing that covers the whole repository instead — `git status` — stats
  // every file in it, which for one file's answer is the whole cost of the request.
  const [headDiff, indexChanges, inIndex, ignored, fileText] = await Promise.all([
    createTrackedFilePatch(repositoryRoot, relativePath, undefined, gitConfig),
    readIndexChanges(repositoryRoot, gitConfig),
    readPathInIndex(repositoryRoot, relativePath, gitConfig),
    readPathIgnored(repositoryRoot, relativePath, gitConfig),
    // A NUL anywhere in a file is content no source view shows, and Git calls a file binary
    // by its first bytes alone, so the file answers for itself here, once.
    onDisk && onDisk.isFile() ? readDiffableFileText(resolvedFilePath) : Promise.resolve(null),
  ]);
  const indexChange = indexChanges?.get(relativePath);
  const decision = classifyFileDiff({
    headDiff,
    indexChange,
    comparedWithHead: indexChanges !== null,
    inIndex,
    ignored,
    onDisk: onDisk !== null,
  });
  if (!decision) return { supported: false };
  // The bytes of a file that is there have to be showable; a path the reader is told was
  // deleted is answered from its patch, as it always was.
  if (onDisk && fileText === null && decision.status !== "deleted") return { supported: false };

  let patch: string | null;
  if (decision.source === "content") {
    if (fileText === null) return { supported: false };
    patch = createAddedFilePatch(relativePath, fileText);
  } else {
    patch = decision.source === "rename-patch"
      ? await createTrackedFilePatch(repositoryRoot, relativePath, indexChange?.originalPath, gitConfig)
      : headDiff;
    if (patch === null) {
      // Git compared the path with nothing at all. Only a file HEAD never held has an answer
      // in its own bytes, under the same size and binary rules as anywhere else here.
      if (decision.status !== "added" || fileText === null) return { supported: false };
      patch = createAddedFilePatch(relativePath, fileText);
    }
  }

  // A hunk's removed side comes from HEAD, where the bytes can be anything.
  if (!patch.includes("\n@@ ") || patch.includes("\0")) return { supported: false };
  return { supported: true, status: decision.status, patch };
}
