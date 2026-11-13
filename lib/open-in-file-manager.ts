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

/** The distro name is in the environment of every process WSL starts; "" off WSL. */
export function wslDistroName(env: NodeJS.ProcessEnv = process.env): string {
  return env.WSL_DISTRO_NAME?.trim() ?? "";
}

/**
 * Which platform's file manager answers for this one: inside WSL it is Windows,
 * reached through the interop PATH, because a Linux desktop opener is both
 * usually absent there and blind to paths the Windows shell can show.
 */
export function fileManagerPlatform(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return platform === "linux" && wslDistroName(env) ? "win32" : platform;
}

/**
 * The Windows form of a path inside WSL: a mounted drive keeps its letter, the
 * rest of the distro is reached through the UNC root named after the distro.
 */
export function windowsPathForWsl(posixPath: string, distro: string): string {
  const trimmed = posixPath.replace(/\/+$/, "") || "/";
  const mount = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed);
  if (mount) {
    const rest = (mount[2] ?? "").replaceAll("/", "\\");
    return `${mount[1].toUpperCase()}:${rest ? `\\${rest}` : "\\"}`;
  }
  return `\\\\wsl.localhost\\${distro}${trimmed.replaceAll("/", "\\")}`;
}

/**
 * What to ask the file manager for: show a folder's contents, or show one file
 * inside the folder that holds it. Receiving a reveal is what a reader means by
 * "look at this file" — the folder alone does not say which of its entries the
 * row was.
 */
export type FileManagerView = "open" | "reveal";

/**
 * Whether to reveal one path or open it. A reveal of a folder opens that folder:
 * a right-clicked directory wants its contents, not its icon in its parent.
 * Null is a path neither view can show (a socket, a device).
 */
export function fileManagerViewFor(
  revealFile: boolean,
  stats: { isDirectory(): boolean; isFile(): boolean },
): FileManagerView | null {
  if (revealFile && !stats.isDirectory()) return stats.isFile() ? "reveal" : null;
  return stats.isDirectory() ? "open" : null;
}

/**
 * Builds the command that shows something in the OS file manager: the directory to open, or
 * the file to reveal among its folder's contents, or null on an unsupported platform. A reveal
 * selects one file where the platform can (`open -R`, `explorer /select,`) and falls back to
 * its folder where it cannot: no Linux file manager has a reveal-from-the-terminal command,
 * and opening the folder still answers the question the reader asked.
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
  // separator: `explorer /select,C:\work\repo\file.ts`. A WSL caller reaches this
  // branch too: it passes `win32` and the Windows form of the path
  // (`fileManagerPlatform()`, `windowsPathForWsl()`).
  if (platform === "win32") return { command, args: [`/select,${target.replaceAll("/", "\\")}`] };
  return { command, args: [dirname(target)] };
}

/**
 * Whether the request's Host header names a loopback address; a missing header is remote.
 *
 * `Host` is client-controlled, so this is a usability guard rather than access control: it
 * keeps a phone or another computer on the LAN from raising a window on the server. The real
 * boundaries are the default 127.0.0.1 bind (only `dev:lan` / `start:lan` listen publicly)
 * and the caller's path allow-list.
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
 * @param target The directory to open, or the file to reveal (the caller checks access)
 * @param platform A Node `process.platform` value
 * @param view Whether to reveal one file rather than open a folder
 * @returns Resolves once the command has started
 */
export function launchFileManager(
  target: string,
  platform: string = process.platform,
  view: FileManagerView = "open",
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const managerPlatform = fileManagerPlatform(platform, env);
  const distro = platform === "linux" ? wslDistroName(env) : "";
  const asked = distro ? windowsPathForWsl(target, distro) : target;
  const spec = fileManagerCommand(managerPlatform, asked, view);
  if (!spec) return Promise.reject(new Error(`Unsupported platform: ${platform}`));
  // On macOS `open` launches an `.app` bundle instead of showing it, so the default
  // `open` view is for project directories such as the explorer root; only a `reveal`
  // passes `open -R`, which shows the bundle in Finder without running it.
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
