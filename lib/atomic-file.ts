import { randomUUID } from "crypto";
import { chmodSync, linkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * Atomically replace a file: the bytes land in a sibling temp file that is then
 * renamed onto the destination, so a process killed mid-write leaves the old
 * file whole. With `exclusive` the destination is hard linked instead, which
 * fails rather than replace one that appeared. `exactMode` gives a replaced
 * file its bits back past the umask. The caller must create the parent
 * directory first.
 */
function writeFileAtomicSync(
  path: string,
  contents: string,
  mode: number,
  options: { exclusive?: boolean; exactMode?: boolean } = {},
): void {
  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    // `wx`: nothing already at the temporary path is written through. An exact mode is set
    // by chmod after the bytes are written at 0600, so text that may hold secrets is never
    // readable by others meanwhile; otherwise `mode` passes through the umask.
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: options.exactMode ? 0o600 : mode,
      flush: true,
    });
    if (options.exactMode) chmodSync(tempPath, mode);
    if (options.exclusive) linkSync(tempPath, path);
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
  writeFileAtomicSync(path, contents, 0o600);
}

/**
 * Replace a session file atomically at pi's own permissions: an existing file keeps
 * its mode, a new one takes pi's 0644 default through the umask, as pi creates them,
 * not the private 0600. `exclusive` keeps the `flag: "wx"` guarantee for the
 * fresh-id copies pi-web writes itself: the replacement refuses a destination that
 * already exists. A symbolic link keeps its link: the bytes replace its target.
 * The caller must create the parent directory first.
 */
export function writeSessionFileAtomicSync(
  path: string,
  contents: string,
  options: { exclusive?: boolean } = {},
): void {
  let target = path;
  try {
    target = realpathSync(path);
  } catch {
    /* a new file */
  }
  const existingMode = statSync(target, { throwIfNoEntry: false })?.mode;
  const mode = existingMode === undefined ? 0o644 : existingMode & 0o777;
  writeFileAtomicSync(target, contents, mode, {
    exclusive: options.exclusive === true,
    exactMode: existingMode !== undefined,
  });
}

/**
 * Replace a file atomically and give it exactly `mode`, whatever the umask.
 * The caller must create the parent directory first.
 */
export function writeFileExactModeAtomicSync(path: string, contents: string, mode: number): void {
  writeFileAtomicSync(path, contents, mode, { exactMode: true });
}
