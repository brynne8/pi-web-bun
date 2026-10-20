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
// Load order is the whole trick, and it is why this is imported first by
// `instrumentation-node.ts` rather than called from a request handler: consumers
// take `realpath` by name, and an ESM named import is captured once when the
// module is evaluated, so patching after `node:fs/promises` has been loaded
// changes nothing (verified). `describeRealpathBinding()` reports which of the
// two cases the process is in, so a start that came too late says so on the log
// instead of failing an edit hours later.
import { promises as fsPromises, realpathSync } from "node:fs";

const installedMarker: unique symbol = Symbol.for("pi-web.dlp-realpath-compat");

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
 * Whether importers evaluating after this point receive the patched function or
 * Node's original: "bound" when the ESM namespace still mirrors `fs.promises`
 * (so it took the patch), "late" when that namespace was created before it.
 */
export async function describeRealpathBinding(): Promise<"bound" | "late"> {
  const namespace = await import("node:fs/promises");
  return namespace.realpath === fsPromises.realpath ? "bound" : "late";
}

if (installDlpRealpathCompat()) {
  // One line per server start. Unawaited like the SDK preimport below it: the
  // patch itself is already installed synchronously, this only reports.
  void describeRealpathBinding()
    .then((binding) => console.log(
      binding === "bound"
        ? "[pi-web] realpath EISDIR fallback loaded (transparent encryption driver)"
        : "[pi-web] warning: realpath EISDIR fallback loaded after node:fs/promises, edit/write of an encrypted file will still fail",
    ))
    .catch(() => {});
}
