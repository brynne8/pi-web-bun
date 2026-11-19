import { existsSync } from "node:fs";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

const MACOS_ZSH = "/bin/zsh";

/**
 * The shell commands run with when no settings layer sets `shellPath`: zsh on
 * macOS, pi's own resolution elsewhere. A path that is not there is left to pi,
 * whose resolution refuses a shell that does not exist.
 */
export function resolveShellPath(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== "darwin") return undefined;
  return exists(MACOS_ZSH) ? MACOS_ZSH : undefined;
}

/** Supplies that default where pi reads `shellPath`; a settings layer keeps the last word. */
export function withShellDefault<T extends Pick<SettingsManager, "getShellPath">>(settingsManager: T): T {
  const readShellPath = settingsManager.getShellPath.bind(settingsManager);
  settingsManager.getShellPath = () => readShellPath() ?? resolveShellPath();
  return settingsManager;
}
