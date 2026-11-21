import { randomBytes } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { parseBgTaskHandle } from "./bg-task-handle.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ID_PATTERN } from "./session-ui-state-shared.ts";

/**
 * A background command's log, and the handle the model uses to fetch it.
 *
 * The log's path never reaches the model: a path is an invitation to read the file directly, and
 * a model that does so still receives the completion report, paying for the same result twice.
 * What the model gets instead is an opaque handle (`bash-3f2a9b1c`) it passes to `get_result`,
 * which is the same read but one that marks the report collected.
 */

export const BG_LOG_DIR = join(tmpdir(), "pi-web-bg-tasks");

/** The bucket for a task whose session id is missing or unusable; never a session's own name. */
export const BG_LOG_UNASSIGNED_DIR = "_unassigned";

/** A pi session id is a UUID; a longer string is not one and does not become a directory name. */
const MAX_BG_LOG_SESSION_ID_LENGTH = 128;

const LOG_NAME_PATTERN = /-([0-9a-f]{8})\.log$/;

/** One slice of a log, numbered the way `read` numbers a file. */
export interface BgTaskLogSlice {
  firstLine: number;
  lastLine: number;
  totalLines: number;
  text: string;
  /** The range held more lines than the byte cap would carry. */
  truncated: boolean;
}

/** A slice's size when the model asked for none: pi's own bash truncation, last lines first. */
export const DEFAULT_SLICE_LINES = 2000;
export const DEFAULT_SLICE_BYTES = 50 * 1024;

/** Cap on the pass that counts a settled log's lines for the pending index. */
const LINE_COUNT_BYTE_CAP = 32 * 1024 * 1024;

/**
 * The one directory name a session's logs may live in: the id itself when it is a single safe path
 * component (`SESSION_ID_PATTERN`, the rule the session id is already validated with everywhere
 * else), otherwise the shared bucket — never the root directory, and never a `..` or a separator
 * on its way out of `BG_LOG_DIR`.
 */
export function bgLogDirName(sessionId?: string): string {
  if (!sessionId || sessionId.length > MAX_BG_LOG_SESSION_ID_LENGTH) return BG_LOG_UNASSIGNED_DIR;
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : BG_LOG_UNASSIGNED_DIR;
}

/** The directory a session's logs live in; created on demand, because a task is starting. */
export function bgLogSessionDir(sessionId?: string): string {
  const dir = join(BG_LOG_DIR, bgLogDirName(sessionId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fresh log path for one task. The name carries a random tail, which is what the handle names. */
export function newBgLogPath(sessionId?: string): string {
  const dir = bgLogSessionDir(sessionId);
  return join(dir, `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.log`);
}

/**
 * The log a handle names, inside the session's own directory. No registry is involved: the handle
 * is the log's own name, so it resolves as long as the log survives the sweep, wrapper or not.
 */
export async function resolveBgTaskLogPath(sessionId: string | undefined, handle: string): Promise<string | null> {
  const random = parseBgTaskHandle(handle);
  if (!random) return null;
  const dir = bgLogSessionDir(sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const match = names.find((name) => LOG_NAME_PATTERN.exec(name)?.[1] === random && name.endsWith(".log"));
  return match ? join(dir, match) : null;
}

/**
 * A log read the way `read` reads a file: 1-based line numbers, a byte cap, and the total on hand
 * so paging has a bound. Without an offset it starts at line 1, as `read` does.
 */
export async function readBgTaskLogSlice(
  path: string,
  options: { offset?: number; limit?: number; maxBytes?: number } = {},
): Promise<BgTaskLogSlice | null> {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? DEFAULT_SLICE_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_SLICE_BYTES;
  const collected: string[] = [];
  let totalLines = 0;
  let bytes = 0;
  let truncated = false;
  let partial = "";
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      partial += chunk;
      let newline = partial.indexOf("\n");
      while (newline !== -1) {
        totalLines += 1;
        collect(partial.slice(0, newline), totalLines);
        partial = partial.slice(newline + 1);
        newline = partial.indexOf("\n");
      }
    }
  } catch {
    return null;
  }
  // A last line without its own newline is still a line; an empty log has none.
  if (partial !== "") {
    totalLines += 1;
    collect(partial, totalLines);
  }

  function collect(line: string, lineNumber: number): void {
    if (lineNumber < offset) return;
    if (lineNumber >= offset + limit || truncated) {
      truncated = true;
      return;
    }
    if (bytes > 0 && bytes + line.length + 1 > maxBytes) {
      truncated = true;
      return;
    }
    bytes += line.length + 1;
    collected.push(line);
  }

  return {
    firstLine: offset,
    lastLine: offset + collected.length - 1,
    totalLines,
    text: collected.join("\n"),
    truncated,
  };
}

/**
 * How many lines a settled log holds, for the pending index. A log past the cap answers null: an
 * index is not worth a hundred-megabyte pass, and a number nobody can act on is not a number.
 */
export async function countBgTaskLogLines(path: string): Promise<number | null> {
  let total = 0;
  let bytes = 0;
  let partial = false;
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
      bytes += chunk.length;
      if (bytes > LINE_COUNT_BYTE_CAP) return null;
      total += (chunk.match(/\n/g)?.length ?? 0);
      partial = !chunk.endsWith("\n");
    }
  } catch {
    return null;
  }
  return partial ? total + 1 : total;
}
