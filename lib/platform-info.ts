import { arch, release } from "node:os";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

const OS_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/**
 * The machine this session runs on as the model reads it: the OS, its arch and
 * kernel, and the shell the user's terminal uses. A line the machine cannot
 * answer — `$SHELL` is unset on Windows — is left out rather than guessed.
 */
export function platformSection(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  kernel?: string;
  shell?: string;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? process.env.SHELL;
  const lines = [`- OS: ${OS_NAMES[platform] ?? platform} (${platform}, ${options.arch ?? arch()}, kernel ${options.kernel ?? release()})`];
  if (shell) lines.push(`- Interactive terminal shell: ${shell.split(/[\\/]/).pop() ?? shell} (${shell})`);
  return lines.join("\n");
}

/**
 * A normal session's own extension, as the bash stand-in is: always on, with no
 * switch and nothing for a package to replace. It describes the machine whose
 * shell the `shellPath` default above picked, so the two cannot disagree.
 */
export function createPlatformInfoExtension(): InlineExtension {
  const section = platformSection();
  return {
    name: "pi-web-platform-info",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        event.systemPromptOptions.sections.platform = section;
      });
    },
  };
}
