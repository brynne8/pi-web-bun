import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homeDir } from "./home-dir";
import { basename, dirname, join, resolve } from "node:path";
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  type ProjectTrustStoreEntry,
} from "@earendil-works/pi-coding-agent";
import type { FreshFolderTrustBreadth, ProjectTrustStatus } from "./api-types";
import { serializeByKey } from "./key-serializer";
import { isPathWithinRoots } from "./path-security";
import { samePath, toNativePath } from "./paths";
import { readRegularFileText } from "./regular-file";

/** The folder as `trust.json` keys it: resolved, then its real path when it exists. */
function trustKeyPath(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Both are one path, written by git; neither is read past that.
const GIT_POINTER_MAX_BYTES = 4096;

/** A pointer file's text, or undefined for anything that is not one (a directory, a FIFO, too large). */
function readGitPointer(path: string): string | undefined {
  try {
    return readRegularFileText(path, GIT_POINTER_MAX_BYTES)?.trim();
  } catch {
    return undefined;
  }
}

/**
 * The main checkout whose trust `cwd` shares, by git's own worktree layout: a
 * `.git` file naming a private dir under `<root>/.git/worktrees`, whose
 * `commondir` leads back to `<root>/.git`. Read without git, so the trust read
 * stays synchronous on every prompt. A checkout, a submodule or a pointer that
 * does not fit the layout is not a worktree.
 */
export function worktreeProjectRoot(cwd: string): string | undefined {
  const pointer = cwd ? readGitPointer(join(cwd, ".git")) : undefined;
  const gitDir = pointer ? /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(pointer)?.[1] : undefined;
  if (!gitDir) return undefined;
  const privateDir = resolve(cwd, toNativePath(gitDir));
  const commonPointer = readGitPointer(join(privateDir, "commondir"));
  if (!commonPointer) return undefined;
  const commonDir = resolve(privateDir, toNativePath(commonPointer));
  if (!samePath(dirname(privateDir), join(commonDir, "worktrees"))) return undefined;
  return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
}

/**
 * The nearest decision for `cwd` — its own or an ancestor's, as the store
 * resolves it — and, when it has none, its main checkout's, so a worktree is
 * trusted exactly as the project it belongs to. A nearer key still wins.
 */
function nearestTrustEntry(cwd: string, store: ProjectTrustStore): ProjectTrustStoreEntry | null {
  const entry = store.getEntry(cwd);
  if (entry) return entry;
  const root = worktreeProjectRoot(cwd);
  return root ? store.getEntry(root) : null;
}

function describeDecision(
  cwd: string,
  entry: ProjectTrustStoreEntry | null,
): Pick<ProjectTrustStatus, "decision" | "decisionPath" | "inherited"> {
  if (!entry) return { decision: null, inherited: false };
  return {
    decision: entry.decision,
    decisionPath: entry.path,
    inherited: !samePath(entry.path, trustKeyPath(cwd)),
  };
}

/**
 * Whether the project at `cwd` needs trust and is trusted, and the decision
 * that answers it: the store resolves the nearest decision, exact or inherited
 * from an ancestor, so `decision` and `decisionPath` tell exact trust from
 * trust through a parent, and no decision from an explicit `false` — which
 * `trusted` alone cannot. Read for a folder that needs no trust too.
 */
export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  const trustStore = new ProjectTrustStore(agentDir);
  if (!requiresTrust) {
    if (!cwd) return { requiresTrust: false, trusted: true, decision: null, inherited: false };
    // As pi 1.5 resolves it (earendil-works/pi#10947): a fresh folder and one inside a
    // trusted tree report `trusted: true`, one under an explicit `false` reports false.
    // Such a folder never failed on an unreadable trust.json before, and callers that only
    // need `trusted` still must not, so that failure is reported in `decisionError`.
    try {
      const entry = nearestTrustEntry(cwd, trustStore);
      return { requiresTrust: false, trusted: entry?.decision ?? true, ...describeDecision(cwd, entry) };
    } catch (error) {
      return {
        requiresTrust: false,
        trusted: true,
        decision: null,
        inherited: false,
        decisionError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const entry = nearestTrustEntry(cwd, trustStore);
  return {
    requiresTrust: true,
    trusted: entry?.decision === true,
    ...describeDecision(cwd, entry),
  };
}

// Hot reload re-evaluates this module; globalThis keeps one warning per error per process.
const TRUST_READ_WARNINGS_KEY: symbol = Symbol.for("pi-web:project-trust-read-warnings");
const TRUST_READ_WARNINGS_MAX = 200;

/**
 * Whether the trust-gated configuration of the project at `cwd` (its
 * `.pi/mcp.json`) may be read right now: true only while the folder requires
 * trust and a decision, exact or inherited, trusts it. The folder's resources
 * and `trust.json` are read on every call, so a decision made anywhere (the
 * trust dialog, the pi CLI) and a `.pi/` resource that landed since count at once.
 */
export function mayReadProjectConfigNow(cwd: string, agentDir: string): boolean {
  try {
    // Not getProjectTrustStatus(): that also reads trust.json for a folder that
    // requires no trust, which this answers false whatever its decision. Twice
    // per prompt, that would lock and read trust.json for nothing.
    //
    // That per-call read is the point: a per-wrapper SettingsManager.isProjectTrusted()
    // is fixed when the wrapper is built — `true` for a folder that needed no trust then,
    // refreshed only on reload. A folder that requires no trust gets false although its
    // status reads `trusted: true`: it has no .pi/mcp.json, so nothing is lost, while true
    // would let the caller read a file that landed between this check and its own read.
    if (!cwd || !hasTrustRequiringProjectResources(cwd)) return false;
    return nearestTrustEntry(cwd, new ProjectTrustStore(agentDir))?.decision === true;
  } catch (error) {
    const trustPath = join(agentDir, "trust.json");
    const message = error instanceof Error ? error.message : String(error);
    const store = globalThis as Record<symbol, Set<string> | undefined>;
    const warned = (store[TRUST_READ_WARNINGS_KEY] ??= new Set());
    const key = `${trustPath}\0${message}`;
    // An unreadable trust.json (unparsable, or still locked by another process after the
    // store's ~200 ms synchronous wait) counts as untrusted, warned once per error.
    if (!warned.has(key)) {
      // The oldest goes, never the whole set, which would repeat every warning it held.
      if (warned.size >= TRUST_READ_WARNINGS_MAX) warned.delete(warned.values().next().value as string);
      warned.add(key);
      // A lock error does not name the file, so the path is always given.
      console.warn(`[pi-web] cannot read project trust from ${trustPath}; projects that need it count as untrusted meanwhile: ${message}`);
    }
    return false;
  }
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  // Built from what was just written, not read back: a second read can fail
  // (the lock held past the store's wait), and the route would then report a
  // decision already on disk as a failure and skip rebuilding the cwd's wrappers.
  return { requiresTrust: true, trusted: true, decision: true, decisionPath: trustKeyPath(cwd), inherited: false };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store, or
 * `undefined` when the project has none, leaving ordinary projects on their
 * existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  // Pi Web *executes* project extensions when it builds session services: their factory
  // runs on import and their `session_start` handlers run on startup, so without a gate,
  // merely opening an untrusted repository runs repository-controlled code locally (#236).
  // The SDK's loader imports them only once `resolveProjectTrust` resolves true, so
  // denying trust keeps them dormant.
  if (!cwd || !hasTrustRequiringProjectResources(cwd)) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  // Pi Web and the `pi` CLI share this store, so a project with gated resources defaults
  // to untrusted until either client records a decision.
  return { resolveProjectTrust: async () => nearestTrustEntry(cwd, trustStore)?.decision === true };
}

// ---------------------------------------------------------------------------
// Trusting a fresh folder in the same step as writing to it (ADR 0006,
// "Fresh folders"). Writing `.pi/mcp.json` makes a folder require trust, and
// `POST /api/project-trust` refuses one that does not require it yet, so
// adding a project server to a folder with no decision would leave the server
// behind Restricted mode with no way to trust it from Pi Web.
// ---------------------------------------------------------------------------

/**
 * The SDK's `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`
 * (`dist/core/trust-manager.js`), which it does not export: what under
 * `<cwd>/.pi` makes a folder require trust. `lib/project-trust.test.mjs`
 * compares it with the SDK's own list, so an upgrade that adds one fails there.
 */
export const TRUST_REQUIRING_PROJECT_ENTRIES = [
  "settings.json",
  "mcp.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
] as const;

function realPathOr(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Something is at `path`, read with `lstat`: a dangling link or a FIFO counts, though `existsSync` would say no. */
function somethingAt(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether anything at all sits where the SDK looks for trust-requiring resources, by
 * `lstat`: `<cwd>/.pi/<entry>` for each of `TRUST_REQUIRING_PROJECT_ENTRIES`, a `.pi` that
 * is a link to nothing, and `.agents/skills` in the folder or an ancestor (not the home
 * folder's own). Stricter than `hasTrustRequiringProjectResources()`, whose `existsSync`
 * skips a link to nothing.
 */
export function hasTrustRelevantEntries(cwd: string, home: string = homeDir()): boolean {
  const folder = realPathOr(cwd);
  // A link to nothing counts: it starts counting the moment its target appears, after the
  // folder was trusted as one with nothing in it.
  if (hasOwnTrustEntries(folder)) return true;
  const userSkills = join(realPathOr(home), ".agents", "skills");
  for (let current = folder; ; current = dirname(current)) {
    const skills = join(current, ".agents", "skills");
    if (!samePath(skills, userSkills) && somethingAt(skills)) return true;
    if (dirname(current) === current) return false;
  }
}

/** What under `folder/.pi` makes it require trust, or a `.pi` that is a link to nothing, by `lstat`. */
function hasOwnTrustEntries(folder: string): boolean {
  const configDir = join(folder, ".pi");
  try {
    if (lstatSync(configDir).isSymbolicLink() && realPathOr(configDir) === configDir) return true;
  } catch {
    // No `.pi`.
  }
  return TRUST_REQUIRING_PROJECT_ENTRIES.some((entry) => somethingAt(join(configDir, entry)));
}

/** How many levels below a fresh folder `findInheritingTrustProject()` looks. */
export const NESTED_PROJECT_SCAN_DEPTH = 4;
/** How many folders it reads before it stops and refuses the step, since it cannot tell. */
export const NESTED_PROJECT_SCAN_MAX_FOLDERS = 2000;
/** Never descended into: dependencies and history hold no project, and `.pi` / `.agents` are checked, not walked. */
const NESTED_PROJECT_SCAN_SKIP = new Set(["node_modules", ".git", ".pi", ".agents"]);

/**
 * A folder below `cwd` that would inherit a decision trusting `cwd`: one with resources that
 * need trust (as `hasTrustRelevantEntries()` looks for them, by `lstat`) and no decision of
 * its own or between it and `cwd`. Fresh folders are mostly containers (`~/work`, a dated
 * `~/pi-cwd`) holding repositories Pi Web has never opened, and trusting the container would
 * load their `.pi/extensions` and connect their `.pi/mcp.json` with no dialog.
 */
export function findInheritingTrustProject(cwd: string, agentDir: string): FreshFolderTrustBreadth | undefined {
  const folder = realPathOr(cwd);
  let store: ProjectTrustStore | undefined;
  const hasDecision = (path: string): boolean => {
    try {
      store ??= new ProjectTrustStore(agentDir);
      return store.getEntry(path) !== null;
    } catch {
      return false;
    }
  };
  let read = 0;
  let level = [folder];
  // Breadth first, never through a link, `node_modules` or `.git`. Past
  // NESTED_PROJECT_SCAN_MAX_FOLDERS folders read it answers `too-many-folders`, refusing
  // what it could not check; folders deeper than the scan are not looked at.
  for (let depth = 0; depth <= NESTED_PROJECT_SCAN_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (read >= NESTED_PROJECT_SCAN_MAX_FOLDERS) return { kind: "too-many-folders", path: folder };
      read += 1;
      let names: Set<string>;
      let children: string[] = [];
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        names = new Set(entries.map((entry) => entry.name));
        if (depth < NESTED_PROJECT_SCAN_DEPTH) {
          children = entries
            .filter((entry) => entry.isDirectory() && !NESTED_PROJECT_SCAN_SKIP.has(entry.name))
            .map((entry) => join(dir, entry.name));
        }
      } catch {
        // Unreadable: nothing below it can be told, nor can a session read it.
        continue;
      }
      // `cwd` itself was checked before (`hasTrustRelevantEntries()`). An exact decision
      // below wins over the new one anyway, so a decided project is not a finding.
      if (depth > 0) {
        const needsTrust = (names.has(".pi") && hasOwnTrustEntries(dir)) || (names.has(".agents") && somethingAt(join(dir, ".agents", "skills")));
        if (needsTrust && !hasDecision(dir)) return { kind: "contains-project", path: dir };
      }
      next.push(...children);
    }
    level = next;
  }
  return undefined;
}

/** `target` is `root` or inside it. */
function within(target: string, root: string): boolean {
  return isPathWithinRoots(target, new Set([root]));
}

/**
 * Why trusting `cwd` would trust more than the one folder, or undefined when
 * it would not. A decision is inherited by every folder below it, so Pi Web never
 * trusts by itself the home folder, a filesystem root, a folder that holds the
 * home folder or Pi's agent folder, one that holds another folder Pi Web knows,
 * or a project with no decision below it. Paths are compared by real path.
 */
export function freshFolderTrustBreadth(
  cwd: string,
  options: { agentDir: string; knownFolders: Iterable<string>; home?: string },
): FreshFolderTrustBreadth | undefined {
  const folder = realPathOr(cwd);
  if (dirname(folder) === folder) return { kind: "root", path: folder };
  const home = realPathOr(options.home ?? homeDir());
  if (samePath(folder, home)) return { kind: "home", path: folder };
  if (within(home, folder)) return { kind: "contains-home", path: home };
  const agentDir = realPathOr(options.agentDir);
  if (within(agentDir, folder)) return { kind: "contains-agent-dir", path: agentDir };
  // `knownFolders` are the folders sessions ran in, their projects, and folders chosen in
  // Pi Web — which is what the allowed file roots hold.
  for (const known of options.knownFolders) {
    const knownFolder = realPathOr(known);
    if (!samePath(knownFolder, folder) && within(knownFolder, folder)) return { kind: "contains-folder", path: knownFolder };
  }
  return findInheritingTrustProject(folder, options.agentDir);
}

export type FreshFolderTrustResult<T> =
  /** Trusted, then written; `status` is the folder's trust as written. */
  | { ok: true; value: T; status: ProjectTrustStatus }
  /** Trusting it would trust more than the folder; nothing was written. */
  | { ok: false; reason: "trust-too-broad"; breadth: FreshFolderTrustBreadth; error: string }
  /** Not fresh anymore (resources that need trust, or a decision here or above); nothing was written. */
  | { ok: false; reason: "folder-not-fresh"; status?: ProjectTrustStatus; error: string }
  /** `trust.json` could not be read or written (unparsable, or locked by another process); nothing was written. */
  | { ok: false; reason: "trust-unreadable"; error: string }
  /**
   * `write` threw after the folder was trusted. The decision was taken back
   * unless `rollbackError` says why it could not be, in which case the folder
   * stays trusted (`status`).
   */
  | { ok: false; reason: "write-failed"; writeError: unknown; rollbackError?: string; status?: ProjectTrustStatus };

// Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one chain per folder per process.
const FRESH_TRUST_LOCKS_KEY: symbol = Symbol.for("pi-web:fresh-folder-trust-locks");

/** Runs `task` after every earlier task for the same folder has settled. */
function serializeForFolder<T>(key: string, task: () => Promise<T>): Promise<T> {
  return serializeByKey(FRESH_TRUST_LOCKS_KEY, key, task);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Trusts a fresh folder and then runs `write` (which makes it require trust, such as adding a
 * server to its `.pi/mcp.json`) as one step. Requests for one folder run one at a time, each
 * re-checking inside the chain that the folder still has no trust-requiring entry, no decision
 * here or above, and no project below that would inherit it. A folder that changed since the
 * panel offered the step is refused with its new status: trusting it would trust what arrived.
 */
export async function trustFreshFolderAndWrite<T>(
  cwd: string,
  agentDir: string,
  write: () => Promise<T> | T,
  options: { knownFolders: Iterable<string>; home?: string },
): Promise<FreshFolderTrustResult<T>> {
  const breadth = freshFolderTrustBreadth(cwd, { agentDir, knownFolders: options.knownFolders, home: options.home });
  if (breadth) {
    return { ok: false, reason: "trust-too-broad", breadth, error: `Trusting ${cwd} would also trust ${breadth.path}` };
  }
  const key = trustKeyPath(cwd);
  // A step that waits gets its turn once the earlier one has finished or been undone, and
  // checks the folder as that left it: unchained, it would find the earlier step's decision
  // while that write is still under way and be refused, even when the write then failed and
  // the decision was taken back. The pi CLI is not serialized against, so it can still add
  // resources between the check and the trust.
  return serializeForFolder(key, async (): Promise<FreshFolderTrustResult<T>> => {
    const store = new ProjectTrustStore(agentDir);
    const notFresh = (error: string): FreshFolderTrustResult<T> => {
      let status: ProjectTrustStatus | undefined;
      try {
        status = getProjectTrustStatus(cwd, agentDir);
      } catch {
        // Unknown: the caller reads it again.
      }
      return { ok: false, reason: "folder-not-fresh", ...(status ? { status } : {}), error };
    };
    if (hasTrustRequiringProjectResources(cwd) || hasTrustRelevantEntries(cwd, options.home)) {
      return notFresh(`${cwd} now has project resources that need trust`);
    }
    let entry: ProjectTrustStoreEntry | null;
    try {
      entry = store.getEntry(cwd);
    } catch (error) {
      return { ok: false, reason: "trust-unreadable", error: message(error) };
    }
    if (entry) return notFresh(`${entry.path} has a trust decision now`);
    // Again inside the chain: a `git clone` into the folder may have landed since the panel offered the step.
    const nested = findInheritingTrustProject(cwd, agentDir);
    if (nested) return { ok: false, reason: "trust-too-broad", breadth: nested, error: `Trusting ${cwd} would also trust ${nested.path}` };
    // Trust comes first, then the write: the likelier failure — a trust.json that is locked
    // or unparsable — then happens before anything is written, and the state in between
    // (trusted, with nothing that needs trust) changes nothing.
    try {
      store.set(cwd, true);
    } catch (error) {
      return { ok: false, reason: "trust-unreadable", error: message(error) };
    }
    const trusted: ProjectTrustStatus = { requiresTrust: true, trusted: true, decision: true, decisionPath: key, inherited: false };
    let value: T;
    try {
      value = await write();
    } catch (writeError) {
      // `set(cwd, null)` removes exactly the key this call wrote: the check found no
      // decision for the folder or above.
      try {
        store.set(cwd, null);
        return { ok: false, reason: "write-failed", writeError };
      } catch (rollbackError) {
        console.warn(`[pi-web] could not take back the trust given to ${cwd} after a failed write: ${message(rollbackError)}`);
        return { ok: false, reason: "write-failed", writeError, rollbackError: message(rollbackError), status: trusted };
      }
    }
    // Built from what was written, as trustProject() does: a second read can fail on the lock.
    //
    // No session was rebuilt and none had to be idle, unlike `POST /api/project-trust`: a
    // wrapper opened in a folder that required no trust was built with projectTrusted true
    // and found no project extensions to load, and its MCP host reads trust afresh before
    // every prompt (mayReadProjectConfigNow()), so the new server connects at its next one.
    return { ok: true, value, status: { ...trusted, requiresTrust: hasTrustRequiringProjectResources(cwd) } };
  });
}
