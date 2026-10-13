import { spawn } from "child_process";
import { isIP } from "net";
import { dirname } from "path";

const FILE_MANAGER_BY_PLATFORM = new Map<string, string>([
  ["win32", "explorer.exe"],
  ["darwin", "open"],
  ["linux", "xdg-open"],
]);

/** Whether the platform has a file manager command. */
export function isFileManagerSupported(platform: string): boolean {
  return FILE_MANAGER_BY_PLATFORM.has(platform);
}

/**
 * What to ask the file manager for: show a folder's contents, or show one file
 * inside the folder that holds it. Receiving a reveal is what a reader means by
 * "look at this file" — the folder alone does not say which of its entries the
 * row was.
 */
export type FileManagerView = "open" | "reveal";

/**
 * Builds the command that shows something in the OS file manager.
 *
 * A reveal selects one file where the platform can (`open -R`, `explorer /select,`)
 * and falls back to its folder where it cannot: no Linux file manager has a
 * reveal-from-the-terminal command, and opening the folder still answers the
 * question the reader asked.
 * @param platform A Node `process.platform` value
 * @param target The directory to open, or the file to reveal
 * @param view `reveal` shows one file among its folder's contents
 * @returns The command and its arguments, or null on an unsupported platform
 */
export function fileManagerCommand(
  platform: string,
  target: string,
  view: FileManagerView = "open",
): { command: string; args: string[] } | null {
  const command = FILE_MANAGER_BY_PLATFORM.get(platform);
  if (!command) return null;
  if (view !== "reveal") return { command, args: [target] };
  if (platform === "darwin") return { command, args: ["-R", target] };
  // explorer.exe takes the switch and the path as one argument, in its own
  // separator: `explorer /select,C:\work\repo\file.ts`.
  if (platform === "win32") return { command, args: [`/select,${target.replaceAll("/", "\\")}`] };
  return { command, args: [dirname(target)] };
}

/**
 * Whether the request's Host header points at this machine.
 *
 * `Host` is client-controlled, so this is a usability guard rather than access
 * control: it keeps a phone or another computer on the LAN from raising a
 * window on the server. The real boundaries are the default 127.0.0.1 bind
 * (only `dev:lan` / `start:lan` listen publicly) and the caller's path
 * allow-list. A missing Host header is treated as remote.
 * @param host The Host header
 * @returns Whether it names a loopback address
 */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  const closingBracket = normalized.indexOf("]");
  const name = normalized.startsWith("[") && closingBracket !== -1
    ? normalized.slice(1, closingBracket)
    : normalized.split(":")[0];
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1") return true;
  return isIP(name) === 4 && name.startsWith("127.");
}

/**
 * Opens a directory, or reveals a file, in the OS file manager.
 *
 * On macOS, `open` launches an `.app` bundle instead of showing it, so callers
 * using the default `open` view should only pass project directories such as the
 * explorer root. A `reveal` passes `open -R`, which shows the bundle in Finder
 * without running it.
 * @param target The directory to open, or the file to reveal (the caller checks access)
 * @param platform A Node `process.platform` value
 * @param view Whether to reveal one file rather than open a folder
 * @returns Resolves once the command has started
 */
export function launchFileManager(
  target: string,
  platform: string = process.platform,
  view: FileManagerView = "open",
): Promise<void> {
  const spec = fileManagerCommand(platform, target, view);
  if (!spec) return Promise.reject(new Error(`Unsupported platform: ${platform}`));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore" });
    // explorer.exe can exit with code 1 even on success, so only a failed spawn counts.
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
