// Transparent-encryption (corporate DLP) compatibility shim.
//
// On some company machines a filesystem filter driver encrypts files behind the
// application's back and then answers its own metadata queries inconsistently:
// `stat` reports the ciphertext length, and the handle-based final-path query
// that `fs.promises.realpath` answers from says the file is a directory, so
//
//   fs.promises.realpath(file)   ->  EISDIR: illegal operation on a directory
//   fs.realpathSync(file)        ->  the correct path
//
// pi takes the mutation-queue key of every `edit` / `write` through the async
// realpath (`dist/core/tools/file-mutation-queue.js`) and tolerates only
// ENOENT/ENOTDIR, so editing such a file fails before a byte is read. This shim
// answers EISDIR with the query that driver does answer, and leaves every other
// error exactly as it was. It changes nothing on a machine with no such driver:
// only an EISDIR ever reaches the fallback.
//
// Reaching that one import takes two ways in, because a named builtin import is
// a frozen snapshot; docs/agents/files-and-access.md says which one the server
// needs and what a Bun process still misses.
import { promises as fsPromises, realpathSync } from "node:fs";
import { register } from "node:module";

const INSTALLED_KEY = "pi-web.dlp-realpath-compat";
const installedMarker: unique symbol = Symbol.for(INSTALLED_KEY);

type RealpathFn = ((path: string, ...rest: never[]) => Promise<unknown>) & {
  [installedMarker]?: boolean;
};

type SyncRealpathFn = (path: string, ...rest: never[]) => unknown;

/** The one `fs.promises` property this shim replaces, structurally. */
interface FsPromisesLike {
  realpath: RealpathFn;
}

/**
 * Wrap one `fs.promises`-shaped object's `realpath`. Returns false when the shim
 * is already on it, so a double load (hot reload, a second entry importing it)
 * cannot wrap the function twice.
 */
export function installDlpRealpathCompat(
  fs: FsPromisesLike = fsPromises as unknown as FsPromisesLike,
  syncRealpath: SyncRealpathFn = realpathSync as SyncRealpathFn,
): boolean {
  if (fs.realpath[installedMarker] === true) return false;
  const originalRealpath = fs.realpath;
  const patched = async function (this: FsPromisesLike, path: string, ...rest: unknown[]): Promise<unknown> {
    try {
      return await originalRealpath.call(this, path, ...(rest as never[]));
    } catch (error) {
      const code = (error as { code?: unknown } | null | undefined)?.code;
      if (code !== "EISDIR") throw error;
      try {
        return syncRealpath(path, ...(rest as never[]));
      } catch {
        // A queue key still has to name the file, and the unresolved path does that.
        return path;
      }
    }
  } as RealpathFn;
  patched[installedMarker] = true;
  fs.realpath = patched;
  return true;
}

/**
 * The URL the loader hook answers `node:fs/promises` with. Not a file URL: the
 * module's source comes from the `load` hook, so nothing has to exist on disk —
 * a file would have to be found again from the built server bundle.
 */
export const DLP_REALPATH_SHADOW_URL = "pi-web:dlp-realpath-shadow";

/**
 * The module that stands in for `node:fs/promises`: the whole real API, plus a
 * `realpath` that answers EISDIR the way the driver does.
 */
export const dlpRealpathShadowSource = `
export * from "node:fs/promises";
export { default } from "node:fs/promises";
import { promises as fsPromises, realpathSync } from "node:fs";

async function patchedRealpath(path, ...rest) {
  try {
    return await fsPromises.realpath(path, ...rest);
  } catch (error) {
    if (error && error.code !== "EISDIR") throw error;
    try {
      return realpathSync(path, ...rest);
    } catch {
      return path;
    }
  }
}
patchedRealpath[Symbol.for(${JSON.stringify(INSTALLED_KEY)})] = true;
export { patchedRealpath as realpath };
`;

/**
 * The loader hook itself. `resolve` sends every `node:fs/promises` import to the
 * shadow — except the shadow's own, which must reach the real builtin or the
 * module would resolve to itself — and `load` supplies the shadow's source.
 */
export const dlpRealpathHookSource = `
export async function resolve(specifier, context, next) {
  if (specifier === "node:fs/promises" && context.parentURL !== ${JSON.stringify(DLP_REALPATH_SHADOW_URL)}) {
    return { url: ${JSON.stringify(DLP_REALPATH_SHADOW_URL)}, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === ${JSON.stringify(DLP_REALPATH_SHADOW_URL)}) {
    return { format: "module", source: ${JSON.stringify(dlpRealpathShadowSource)}, shortCircuit: true };
  }
  return next(url, context);
}
`;

const shadowKey = Symbol.for("pi-web.dlp-realpath-shadow");

/**
 * Point every later `import ... from "node:fs/promises"` at the shadow. False
 * when there is nothing to register: once per process, and never under Bun,
 * whose `module.register` runs no hooks. Must run before the pi SDK is imported,
 * which is why `instrumentation-node.ts` imports this module first.
 */
export function registerFsPromisesShadow(): boolean {
  if (process.versions.bun) return false;
  const store = globalThis as Record<symbol, boolean | undefined>;
  if (store[shadowKey] === true) return false;
  store[shadowKey] = true;
  // The parent is not consulted: the specifier is absolute.
  register(`data:text/javascript,${encodeURIComponent(dlpRealpathHookSource)}`, import.meta.url);
  return true;
}

/** Whether a named import of `node:fs/promises` reaches the EISDIR fallback. */
export type RealpathCoverage =
  /** It does: the shadow answers, or the object patch landed before the freeze. */
  | "named"
  /** Only `fs.promises` / the default export is patched, so pi's import is not. */
  | "object"
  /** Nothing is installed at all. */
  | "none";

function carriesMarker(value: unknown): boolean {
  return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[installedMarker] === true;
}

/**
 * What a consumer of `node:fs/promises` actually gets in this process. Asking
 * the namespace is the point: it is the snapshot pi's import is bound to, so
 * this measures the thing that matters rather than whether a patch ran.
 */
export async function describeRealpathCoverage(): Promise<RealpathCoverage> {
  const namespace = await import("node:fs/promises");
  if (carriesMarker(namespace.realpath)) return "named";
  if (carriesMarker(fsPromises.realpath)) return "object";
  return "none";
}

const COVERAGE_LOG: Record<RealpathCoverage, string> = {
  named: "[pi-web] realpath EISDIR fallback loaded (transparent encryption driver)",
  object:
    "[pi-web] warning: realpath EISDIR fallback reached fs.promises only, edit/write of an encrypted file will still fail",
  none: "[pi-web] warning: realpath EISDIR fallback not loaded, edit/write of an encrypted file will fail on a transparent encryption driver",
};

const reportedKey = Symbol.for("pi-web.dlp-realpath-reported");

/**
 * Say, once per process, which of the two ways in a consumer of
 * `node:fs/promises` got. Called from `instrumentation-node.ts`, where the
 * server starts; a preload that imports this module for the patch stays quiet.
 */
export function reportRealpathCoverage(log: (line: string) => void = console.log): void {
  const store = globalThis as Record<symbol, boolean | undefined>;
  if (store[reportedKey] === true) return;
  store[reportedKey] = true;
  void describeRealpathCoverage()
    .then((coverage) => log(COVERAGE_LOG[coverage]))
    .catch(() => {});
}

installDlpRealpathCompat();
registerFsPromisesShadow();
