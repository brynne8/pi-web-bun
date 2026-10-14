import { lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import { readRegularFileText } from "./regular-file";
import {
  applySessionUiStateRequest,
  dropProjectUiState,
  emptySessionUiState,
  normalizeSessionUiState,
  SESSION_UI_STATE_VERSION,
  type SessionUiState,
  type SessionUiStateRequest,
} from "./session-ui-state-shared";

// The sidebar's pins, archive, project order and project names
// (`lib/session-ui-state-shared.ts` has the rules) in `pi-web-session-state.json`
// beside pi's own files. It holds what the user chose, so unlike the session
// index it is never rebuilt: writes are serialized in-process, locked against
// other processes, replaced atomically, and a file that cannot be parsed is
// set aside, never overwritten. Project-keyed state is the one thing that
// leaves it by itself: a project whose folder is gone loses its pin, its place
// in the order and its name with the next delete (`forgetSessionUiState()`).

const MAX_BYTES = 4 * 1024 * 1024;
// `__proto__` is never copied: assigning it would set the object's prototype instead.
const KNOWN_KEYS = new Set(["version", "revision", "sessions", "projects", "projectOrder", "projectNames", "__proto__"]);

// Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one queue per process.
const QUEUE_KEY: symbol = Symbol.for("pi-web:session-ui-state-write-queue");

/**
 * About three seconds of retries in all, as for `mcp.json`: writes are
 * serialized before the lock, so only another process holds it, and only for
 * one short write. A compromised lock is logged: proper-lockfile's default
 * throws from a timer, which would take the whole server down.
 */
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the session UI state lock was compromised: ${error.message}`);
  },
};

/** Another process held the file's lock for longer than the retries wait. */
export class SessionUiStateLockedError extends Error {
  constructor(message = "Another process holds the session UI state lock") {
    super(message);
    this.name = "SessionUiStateLockedError";
  }
}

interface CachedRead {
  mtimeMs: number;
  size: number;
  ino: number;
  state: SessionUiState;
}

interface SessionUiStateCache {
  /** The last read per path, valid while the file's stat fingerprint matches. */
  reads: Map<string, CachedRead>;
  /** The highest revision seen per path, so a reset after a corrupt or removed file still moves forward. */
  revisions: Map<string, number>;
}

declare global {
  var __piWebSessionUiStateCache: SessionUiStateCache | undefined;
}

function cache(): SessionUiStateCache {
  return (globalThis.__piWebSessionUiStateCache ??= { reads: new Map(), revisions: new Map() });
}

function noteRevision(path: string, revision: number): void {
  const revisions = cache().revisions;
  if (revision > (revisions.get(path) ?? -1)) revisions.set(path, revision);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Callers get their own copy: the cached state is shared by every later read. */
function copyState(state: SessionUiState): SessionUiState {
  return structuredClone(state);
}

export function getSessionUiStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-session-state.json");
}

type Parsed = { ok: true; state: SessionUiState; raw: Record<string, unknown> } | { ok: false };

function parseStateText(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const state = normalizeSessionUiState(raw);
  return state ? { ok: true, state, raw: raw as Record<string, unknown> } : { ok: false };
}

/**
 * The file's state through the stat-keyed cache. Missing reads as empty and an
 * unparsable file as empty (warned once per version of it); anything else, such
 * as a file that is not a regular one or is too large, throws.
 */
function loadState(path: string): SessionUiState {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      cache().reads.delete(path);
      return emptySessionUiState();
    }
    throw error;
  }
  const cached = cache().reads.get(path);
  // An atomic replace gives the file a new inode, so a write within the mtime's granularity is still seen.
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && cached.ino === stats.ino) {
    return cached.state;
  }
  // Read after the stat: a write in between leaves a fingerprint older than the text, which only costs one more read.
  const text = readRegularFileText(path, MAX_BYTES);
  if (text === undefined) {
    cache().reads.delete(path);
    return emptySessionUiState();
  }
  const parsed = parseStateText(text);
  let state: SessionUiState;
  if (parsed.ok) {
    state = parsed.state;
    noteRevision(path, state.revision);
  } else {
    console.warn(`[pi-web] ${path} is not valid session UI state; reading it as empty until the next change sets it aside`);
    state = emptySessionUiState();
  }
  cache().reads.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, state });
  return state;
}

/** Never throws; missing/corrupt → empty (does not rewrite on read). */
export function readSessionUiState(path?: string): SessionUiState {
  try {
    return copyState(loadState(path ?? getSessionUiStatePath()));
  } catch (error) {
    console.warn(`[pi-web] could not read the session UI state: ${error instanceof Error ? error.message : String(error)}`);
    return emptySessionUiState();
  }
}

/** Cheap enough for the running poll: one stat while the file is unchanged. Null on an unexpected error. */
export function getSessionUiStateRevision(path?: string): number | null {
  try {
    return loadState(path ?? getSessionUiStatePath()).revision;
  } catch {
    return null;
  }
}

/** Sets an unparsable file aside beside itself; best effort. */
function backUpCorruptFile(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} could not be parsed; moved it to ${backup} and started from an empty session UI state`);
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be parsed and could not be moved aside (${error instanceof Error ? error.message : String(error)}); starting from an empty session UI state`);
  }
}

/**
 * Reads the file under the lock, applies `edit`, and replaces the file when it
 * changed something, with the revision bumped. Unknown top-level fields of a
 * valid file are kept for a newer build.
 */
function editState(
  path: string,
  edit: (state: SessionUiState) => { state: SessionUiState; changed: boolean },
): Promise<SessionUiState> {
  return serializeByKey(QUEUE_KEY, path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) === "ELOCKED") throw new SessionUiStateLockedError();
      throw error;
    }
    try {
      const lastRevision = cache().revisions.get(path) ?? 0;
      const text = readRegularFileText(path, MAX_BYTES);
      let state: SessionUiState;
      const extras: Record<string, unknown> = {};
      let reset = false;
      if (text === undefined) {
        // A removed file starts over, but its revision keeps counting so clients notice.
        state = { ...emptySessionUiState(), revision: lastRevision };
      } else {
        const parsed = parseStateText(text);
        if (parsed.ok) {
          state = parsed.state;
          for (const [key, value] of Object.entries(parsed.raw)) {
            if (!KNOWN_KEYS.has(key)) extras[key] = value;
          }
        } else {
          backUpCorruptFile(path);
          state = { ...emptySessionUiState(), revision: lastRevision + 1 };
          // The file was moved away: write the fresh state even when the edit itself changes nothing.
          reset = true;
        }
      }
      const result = edit(state);
      if (!result.changed && !reset) return copyState(state);
      const next: SessionUiState = { ...result.state, version: SESSION_UI_STATE_VERSION, revision: state.revision + (result.changed ? 1 : 0) };
      const document = {
        version: next.version,
        revision: next.revision,
        sessions: next.sessions,
        projects: next.projects,
        ...(next.projectOrder?.length ? { projectOrder: next.projectOrder } : {}),
        ...(next.projectNames && Object.keys(next.projectNames).length > 0 ? { projectNames: next.projectNames } : {}),
        ...extras,
      };
      writePrivateFileAtomicSync(path, JSON.stringify(document, null, 2) + "\n");
      noteRevision(path, next.revision);
      try {
        const stats = statSync(path);
        cache().reads.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, state: copyState(next) });
      } catch {
        cache().reads.delete(path);
      }
      return copyState(next);
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock was already reported through onCompromised.
      }
    }
  });
}

export function updateSessionUiState(request: SessionUiStateRequest, path?: string): Promise<SessionUiState> {
  let target: string;
  try {
    target = path ?? getSessionUiStatePath();
  } catch (error) {
    return Promise.reject(error);
  }
  return editState(target, (state) => applySessionUiStateRequest(state, request, Date.now()));
}

/**
 * The folder a project key stands for: the root its pin recorded (the path it
 * was pinned at, what the sidebar shows for a project with no live session),
 * else the key itself, which is `workspaceKeyOf()` — a project root or a cwd.
 * A key that is no absolute path is no folder this process can judge.
 */
function projectFolderOf(state: SessionUiState, key: string): string | null {
  const entry = Object.prototype.hasOwnProperty.call(state.projects, key) ? state.projects[key] : undefined;
  const path = entry?.root ?? key;
  return isAbsolute(path) ? path : null;
}

/**
 * Whether a project's folder is gone. `lstat`, as `lib/project-trust.ts` reads
 * a folder: only "no such file" (ENOENT, or ENOTDIR, a parent that became a
 * file) says so. A dangling link, a FIFO or a folder this process may not read
 * (EACCES, ELOOP, a name too long) stays: none of those says the user deleted
 * anything, and this is the one change no undo can undo — pruning is for a
 * folder that is really not there, and an existing one keeps its slot and name.
 */
function projectFolderGone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/**
 * The project keys `state` holds state for whose folder is gone: pinned
 * entries, the order's keys and the names, each judged by its own
 * `projectFolderOf()`. One `lstat` per key, and a state without project-keyed
 * entries costs nothing — which is what lets a delete that forgets nothing
 * still skip the lock.
 */
function goneProjectKeys(state: SessionUiState): string[] {
  const keys = new Set([
    ...Object.keys(state.projects),
    ...(state.projectOrder ?? []),
    ...Object.keys(state.projectNames ?? {}),
  ]);
  const gone: string[] = [];
  for (const key of keys) {
    const folder = projectFolderOf(state, key);
    if (folder !== null && projectFolderGone(folder)) gone.push(key);
  }
  return gone;
}

/**
 * Removes those session entries and, with them, everything the state holds for
 * a project whose folder no longer exists: its pin, its place in `projectOrder`
 * and its display name. Without that a throwaway default directory
 * (`~/pi-cwd/YYYYMMDD`, which users delete) keeps its row in the order forever
 * and the file never shrinks.
 *
 * No-op — no lock, nothing created — when nothing is forgotten: no session
 * entry present and no project folder gone. The `lstat`s are all that costs.
 * A file that cannot be read throws here: the locked read could not do better.
 */
export async function forgetSessionUiState(ids: Iterable<string>, path?: string): Promise<void> {
  const target = path ?? getSessionUiStatePath();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return;
  const forgets = (state: SessionUiState) => ({
    ids: wanted.some((id) => Object.prototype.hasOwnProperty.call(state.sessions, id)),
    gone: goneProjectKeys(state),
  });
  const before = forgets(loadState(target));
  if (!before.ids && before.gone.length === 0) return;
  await editState(target, (state) => {
    const now = forgets(state);
    if (!now.ids && now.gone.length === 0) return { state, changed: false };
    let next = state;
    if (now.ids) {
      const sessions = { ...state.sessions };
      for (const id of wanted) delete sessions[id];
      next = { ...state, sessions };
    }
    if (now.gone.length > 0) next = dropProjectUiState(next, now.gone).state;
    return { state: next, changed: true };
  });
}

export function resetSessionUiStateCacheForTests(): void {
  globalThis.__piWebSessionUiStateCache = undefined;
}
