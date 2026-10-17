/**
 * Deleting session files: DELETE /api/sessions/[id] (a row's Delete) and
 * POST /api/sessions/delete (a project group's "Delete all sessions"). Each
 * named session goes with every subagent session below it, persisted or
 * live. A session left behind whose header names a deleted one as its parent
 * is re-pointed at the nearest ancestor still there (`parentSession` is
 * display metadata only, so the rewrite is safe). Open wrappers are shut down,
 * subagents before their parents, before the files go; then the pins and
 * archive times of every deleted id are forgotten. A folder the delete
 * emptied goes with its files: `rmdirSync` on exactly the folders it unlinked
 * from, empty-only, never a symlink, never a recurse, every failure ignored
 * (a session written into the folder meanwhile keeps it). pi leaves the
 * folder behind.
 *
 * One call lists the catalogue and enumerates the sessions root once, however
 * many sessions it deletes: a project's hundreds of sessions deleted one
 * request each would read every file of the folder once per session. The scan
 * reaches the whole sessions root, not just the folders the delete names — a
 * subagent run with `isolation` gets a worktree as its cwd, so its file lives
 * in a folder encoded from the worktree path, a different folder from its
 * parent's — but the cost stays bounded the same way as before: one bounded
 * header read per file, and a body read only where the metadata probe or a
 * rewrite needs one. Every pass shares the header and body caches keyed by
 * path, so a file is still read at most once per call.
 */

// The whole module reads the filesystem through the default import at call
// time (`fs.readdirSync(…)`), not named bindings: a named builtin import is a
// frozen snapshot under Bun, so a test could not count the reads this makes.
// See docs/agents/tests.md.
import fs from "fs";
import type { Dirent } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeSessionFileAtomicSync } from "./atomic-file";
import { deleteBgLogsForSession } from "./bash-bg-tasks";
import { abortSubagent, getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds } from "./rpc-manager";
import {
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  invalidateSessionPathCache,
  listAllSessions,
  mergeSessionLists,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { sessionPathKey } from "./session-path";
import { forgetSessionUiState } from "./session-ui-state";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";
import type { SessionEntry, SessionHeader } from "./types";

/** Most ids one POST /api/sessions/delete takes; the sidebar sends a bigger project in parts. */
export const MAX_SESSION_DELETE_IDS = 500;

export interface SessionDeleteResult {
  /** Every session removed: the named ones and the subagent sessions below them. */
  deleted: string[];
  /** Named ids with neither a file nor a cached path. */
  missing: string[];
  /** Named ids kept because a session of theirs runs (`keepRunning` only). */
  running: string[];
}

function addChild(childrenByParent: Map<string, string[]>, parentId: string, childId: string): void {
  const children = childrenByParent.get(parentId) ?? [];
  children.push(childId);
  childrenByParent.set(parentId, children);
}

/**
 * Every `.jsonl` under the sessions root, one project folder at a time — the
 * same walk `lib/session-list-scanner.ts` does for the catalogue (its helper
 * is private and async, so this is the synchronous twin, with the same
 * semantics: project dirs and symlinks to them, unreadable folders skipped as
 * absent, and nothing thrown at the caller). Every folder it listed goes in
 * `listedDirs`, so a later folder scan asks for a folder no twice.
 */
function enumerateSessionFiles(sessionsDir: string, listedDirs: Set<string>): string[] {
  let entries: Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  listedDirs.add(sessionsDir);
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dirPath = join(sessionsDir, entry.name);
    listedDirs.add(dirPath);
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (file.endsWith(".jsonl")) files.push(join(dirPath, file));
      }
    } catch { /* unreadable project dir: same skip-as-absent semantics as the scanner */ }
  }
  return files;
}

/** The `.jsonl` of one folder, skipped as absent when it cannot be read. */
function listJsonl(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/**
 * Deletes `ids` and their subagent sessions. With `keepRunning`, a named
 * session is left alone when it or a subagent below it runs: a bulk delete
 * the user confirmed a moment ago must not stop a run that started since.
 */
export async function deleteSessions(
  ids: readonly string[],
  options: { keepRunning?: boolean } = {},
): Promise<SessionDeleteResult> {
  const targets = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const filePath = await resolveSessionPath(id);
    if (filePath) targets.set(id, filePath);
    else missing.push(id);
  }
  if (targets.size === 0) return { deleted: [], missing, running: [] };

  // Read only the bounded headers before deleting, and keep them: every later
  // pass asks for the same header, and a file's header is opened at most once.
  const parentPathByKey = new Map<string, string | undefined>();
  const headerByKey = new Map<string, SessionHeader | null>();
  for (const filePath of targets.values()) {
    let parentSessionPath: string | undefined;
    try {
      const header = readSessionHeader(filePath);
      headerByKey.set(sessionPathKey(filePath), header);
      parentSessionPath = header?.parentSession;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    parentPathByKey.set(sessionPathKey(filePath), parentSessionPath);
  }
  const headerOf = (filePath: string): SessionHeader | null => {
    const key = sessionPathKey(filePath);
    if (headerByKey.has(key)) return headerByKey.get(key) ?? null;
    let header: SessionHeader | null = null;
    try {
      header = readSessionHeader(filePath);
    } catch { /* unreadable or malformed: every pass below treats it as no parent */ }
    headerByKey.set(key, header);
    return header;
  };

  const targetPathKeys = new Set([...targets.values()].map((path) => sessionPathKey(path)));
  // Deleting a session also deletes every persisted or live subagent below it.
  const sessions = mergeSessionLists(
    await listAllSessions({ force: true }),
    getRpcSessionInfos({ includeTransient: true }),
  );
  const childrenByParent = new Map<string, string[]>();
  const indexedChildIds = new Set<string>();
  for (const session of sessions) {
    if (session.relation?.kind === "subagent") {
      addChild(childrenByParent, session.relation.parentSessionId, session.id);
      indexedChildIds.add(session.id);
    }
  }
  const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
  // Include local files even when the global catalogue is stale or incomplete
  // — and look through the whole sessions root, not just the folders the
  // delete names: a subagent run with `isolation` gets a git worktree as its
  // cwd (`lib/subagent-runtime.ts`), so its file sits in the folder encoded
  // from that worktree path, a different folder from its parent's. A
  // folder-local scan left that child behind pointing at a deleted parent
  // whenever the catalogue missed the folder. The folders the delete itself
  // names stay in view on top of the root listing: a cached or transient path
  // can name a folder outside the root, which is what the folder-local scan
  // used to cover.
  const sessionsRoot = join(getAgentDir(), "sessions");
  const listedDirs = new Set<string>();
  const scannedFiles = enumerateSessionFiles(sessionsRoot, listedDirs);
  for (const dir of new Set([...targets.values()].map((path) => dirname(path)))) {
    if (listedDirs.has(dir)) continue;
    listedDirs.add(dir);
    scannedFiles.push(...listJsonl(dir));
  }
  // The scan stays bounded: a body is read only for a file whose bounded
  // header names a parent this delete could take away — a family member by
  // the catalogue or a child the scan itself just found, so a missed child's
  // own children, in yet another folder, are found too. The scan repeats
  // while the family still grows; every repeat is pure memory for files
  // already looked at, and a file's body is read at most once either way.
  const familyPathKeys = new Set(targetPathKeys);
  const bodyByKey = new Map<string, string[]>();
  const seededIds = new Set<string>();
  const seedFamily = (sessionId: string) => {
    const stack = [sessionId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seededIds.has(current)) continue;
      seededIds.add(current);
      for (const childId of childrenByParent.get(current) ?? []) {
        const childPath = sessionPaths.get(childId);
        if (childPath) familyPathKeys.add(sessionPathKey(childPath));
        stack.push(childId);
      }
    }
  };
  for (const id of targets.keys()) seedFamily(id);
  for (let grew = true; grew; ) {
    grew = false;
    for (const childPath of scannedFiles) {
      const key = sessionPathKey(childPath);
      if (targetPathKeys.has(key) || bodyByKey.has(key)) continue;
      // The header says whether this file can belong to a deleted family at
      // all: only a session with a parent can carry subagent metadata, and
      // only one under a path this delete reaches is worth a full parse.
      const scannedHeader = headerOf(childPath);
      if (!scannedHeader?.parentSession || !familyPathKeys.has(sessionPathKey(scannedHeader.parentSession))) continue;
      if (typeof scannedHeader.id === "string" && indexedChildIds.has(scannedHeader.id)) continue;
      try {
        const lines = fs.readFileSync(childPath, "utf8").split("\n");
        bodyByKey.set(key, lines);
        const header = JSON.parse(lines[0]) as { type?: string; id?: string };
        if (header.type !== "session" || typeof header.id !== "string") continue;
        const entries = lines.slice(1).flatMap((line) => {
          try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
        });
        const subagent = readSubagentRun(entries, header.id, childPath);
        if (!subagent) continue;
        addChild(childrenByParent, subagent.parentSessionId, header.id);
        sessionPaths.set(header.id, childPath);
        const familySizeBefore = familyPathKeys.size;
        familyPathKeys.add(key);
        seedFamily(header.id);
        if (familyPathKeys.size > familySizeBefore) grew = true;
      } catch { /* skip malformed or concurrently removed sessions */ }
    }
  }

  // Each named session with the subagents below it, children before their
  // parent: wrappers are shut down in this order.
  const runningIds = options.keepRunning ? new Set(getRunningRpcSessionIds()) : new Set<string>();
  const deletedSessionIds = new Set<string>();
  const running: string[] = [];
  for (const id of targets.keys()) {
    if (deletedSessionIds.has(id)) continue;
    const family: string[] = [];
    const seen = new Set<string>();
    const visit = (sessionId: string) => {
      if (seen.has(sessionId) || deletedSessionIds.has(sessionId)) return;
      seen.add(sessionId);
      for (const childId of childrenByParent.get(sessionId) ?? []) visit(childId);
      family.push(sessionId);
    };
    visit(id);
    if (family.some((sessionId) => runningIds.has(sessionId))) {
      running.push(id);
      continue;
    }
    for (const sessionId of family) deletedSessionIds.add(sessionId);
  }

  const deletedPaths = new Map<string, string>();
  for (const deletedId of deletedSessionIds) {
    const sessionPath = targets.get(deletedId) ?? sessionPaths.get(deletedId) ?? getRpcSession(deletedId)?.sessionFile
      ?? await resolveSessionPath(deletedId);
    if (sessionPath) deletedPaths.set(deletedId, sessionPath);
  }
  const deletedPathKeys = new Map([...deletedPaths.values()].map((path) => [sessionPathKey(path), path]));

  // A session left behind whose parent goes is re-attached to the nearest
  // ancestor that stays (cascade re-parent).
  const survivingParent = (parentSessionPath: string | undefined): string | undefined => {
    const seen = new Set<string>();
    let current = parentSessionPath;
    while (current) {
      const key = sessionPathKey(current);
      const deletedPath = deletedPathKeys.get(key);
      if (deletedPath === undefined) return current;
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (!parentPathByKey.has(key)) {
        // A subagent's file may be gone already; it then re-attaches nothing.
        parentPathByKey.set(key, headerOf(deletedPath)?.parentSession);
      }
      current = parentPathByKey.get(key);
    }
    return undefined;
  };
  if (deletedPaths.size > 0) {
    // The same enumerated listing, so a surviving child is found wherever it
    // sits: an isolated run's file lives in its worktree's folder, not its
    // parent's. A deleted file outside the sessions root adds its own folder,
    // as the folder-local scan did. Headers and bodies come from the scan's
    // caches where already read, so this pass opens a given file no more than
    // once per delete.
    const reParentFiles = [...scannedFiles];
    for (const deletedPath of deletedPaths.values()) {
      const dir = dirname(deletedPath);
      if (listedDirs.has(dir)) continue;
      listedDirs.add(dir);
      reParentFiles.push(...listJsonl(dir));
    }
    for (const childPath of reParentFiles) {
      const key = sessionPathKey(childPath);
      if (deletedPathKeys.has(key)) continue;
      try {
        // The bounded header says whether it needs a rewrite at all.
        const childParent = headerOf(childPath)?.parentSession;
        if (!childParent || !deletedPathKeys.has(sessionPathKey(childParent))) continue;
        const parentSessionPath = survivingParent(childParent);
        let parentSessionId: string | undefined;
        if (parentSessionPath) {
          // The parent may have been deleted or moved already; treat it as absent.
          parentSessionId = headerOf(parentSessionPath)?.id;
        }
        const lines = bodyByKey.get(key) ?? fs.readFileSync(childPath, "utf8").split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (header.type !== "session") continue;
        // Rewrite header with new parentSession
        header.parentSession = parentSessionPath;
        lines[0] = JSON.stringify(header);
        if (parentSessionPath && parentSessionId) {
          for (let index = 1; index < lines.length; index += 1) {
            let entry: { type?: string; customType?: string; data?: unknown };
            try {
              entry = JSON.parse(lines[index]);
            } catch {
              continue;
            }
            if (
              entry.type !== "custom"
              || entry.customType !== SUBAGENT_META_TYPE
              || typeof entry.data !== "object"
              || entry.data === null
              || Array.isArray(entry.data)
            ) continue;
            entry.data = {
              ...entry.data,
              parentSessionId,
              parentSessionPath,
            };
            lines[index] = JSON.stringify(entry);
            break;
          }
        }
        // Atomic and mode-preserving: a kill mid-rewrite leaves the old file
        // whole, not a truncated one, and the child keeps pi's own permissions.
        writeSessionFileAtomicSync(childPath, lines.join("\n"));
      } catch { /* skip malformed */ }
    }
  }

  for (const deletedId of deletedSessionIds) {
    try { await abortSubagent(deletedId); } catch { /* ordinary session, idle or completed */ }
    await getRpcSession(deletedId)?.shutdown();
    // The wrapper's destroy has aborted the session's background commands, so
    // no writer holds its log files: they go with the session (lib/bash-bg-tasks.ts).
    deleteBgLogsForSession(deletedId);
  }
  const emptiedDirs = new Set<string>();
  for (const [deletedId, deletedPath] of deletedPaths) {
    try {
      fs.unlinkSync(deletedPath);
      emptiedDirs.add(dirname(deletedPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    invalidateSessionPathCache(deletedId);
    invalidateSessionManagerCache(deletedPath);
  }
  // A folder this delete emptied goes with its files, so an emptied project
  // leaves nothing behind — including a subagent run with `isolation`, whose
  // folder is named after a worktree that is itself already gone. Only the
  // folders this delete took a file from, only ever empty ones (rmdirSync
  // never recurses), never a symlinked folder, and never the sessions root.
  // Every failure is ignored: a session created here while we deleted wins
  // the folder (ENOTEMPTY), and with the .jsonl files already gone a
  // leftover folder is never worth failing the delete for.
  for (const dir of emptiedDirs) {
    if (dir === sessionsRoot) continue;
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) continue;
      fs.rmdirSync(dir);
    } catch { /* not empty, gone, busy, protected: the folder stays */ }
  }
  // Drop their pins and archive times; best effort, the files are already gone.
  try {
    await forgetSessionUiState(deletedSessionIds);
  } catch (error) {
    console.warn(`[pi-web] could not clear the sidebar state of deleted sessions: ${error instanceof Error ? error.message : String(error)}`);
  }
  invalidateSessionListCache();
  return { deleted: [...deletedSessionIds], missing, running };
}
