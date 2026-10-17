import { randomUUID } from "crypto";
import { chmodSync, linkSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Atomically replace a file: the bytes land in a sibling temp file that is then
 * renamed onto the destination, so a process killed mid-write leaves the old
 * file whole. With `exclusive` the destination is hard linked instead, which
 * fails rather than replace one that appeared. The caller must create the
 * parent directory first.
 */
function writeFileAtomicSync(path: string, contents: string, mode: number, exclusive: boolean): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode,
      flush: true,
    });
    if (exclusive) linkSync(tempPath, path);
    else renameSync(tempPath, path);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  writeFileAtomicSync(path, contents, 0o600, false);
}

/**
 * Replace a session file atomically at pi's own permissions: an existing file
 * keeps the mode it has, and a new one takes pi's 0644 default (through the
 * umask, as pi creates them) rather than the private 0600. `exclusive` keeps
 * the `flag: "wx"` guarantee for the fresh-id copies pi-web writes itself: the
 * replacement refuses a destination that already exists instead of clobbering
 * it. The caller must create the parent directory first.
 */
export function writeSessionFileAtomicSync(
  path: string,
  contents: string,
  options: { exclusive?: boolean } = {},
): void {
  const existing = statSync(path, { throwIfNoEntry: false });
  const existingMode = existing ? existing.mode & 0o777 : undefined;
  writeFileAtomicSync(path, contents, existingMode ?? 0o644, options.exclusive === true);
  // A new file's mode is masked by the umask; an existing file must keep the
  // exact bits pi gave it.
  if (existingMode !== undefined) chmodSync(path, existingMode);
}
