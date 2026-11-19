import { existsSync, readlinkSync } from "node:fs";
import { arch, release } from "node:os";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { readRegularFileText } from "./regular-file";

const OS_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const OS_RELEASE_PATH = "/etc/os-release";
const OS_RELEASE_MAX_BYTES = 64 * 1024;
/** Node's arch names against the musl loader's, which the libc check looks for. */
const MUSL_LOADER_ARCH: Record<string, string> = {
  x64: "x86_64", arm64: "aarch64", ia32: "i386", arm: "arm", ppc64: "powerpc64le",
  s390x: "s390x", loong64: "loongarch64", riscv64: "riscv64", mips64el: "mips64el",
};

export interface PlatformQuery {
  platform?: NodeJS.Platform;
  arch?: string;
  kernel?: string;
  shell?: string;
  /** The text of `/etc/os-release`, when the machine has one. */
  osRelease?: string;
  /** Where `$SHELL` points, when it is a symlink. */
  shellLink?: string;
  /** Whether the musl loader is installed. */
  muslLoader?: boolean;
}

/** One `KEY=value` field of an os-release text, unquoted. */
function fieldOf(osRelease: string, key: string): string | undefined {
  const value = new RegExp(`^${key}=(.*)$`, "m").exec(osRelease)?.[1]?.trim();
  return value?.replace(/^["']|["']$/g, "") || undefined;
}

/**
 * "Alpine Linux v3.21" from an os-release text, or undefined when it names
 * none. On Linux `process.platform` says only "linux"; this is what says which.
 */
export function distroName(osRelease: string | undefined): string | undefined {
  if (!osRelease) return undefined;
  return fieldOf(osRelease, "PRETTY_NAME") ?? fieldOf(osRelease, "NAME") ?? undefined;
}

/** musl when its loader is installed or the os-release names Alpine, else glibc. */
export function libcOf(options: { muslLoader?: boolean; osRelease?: string } = {}): string {
  if (options.muslLoader) return "musl";
  return options.osRelease && fieldOf(options.osRelease, "ID") === "alpine" ? "musl" : "glibc";
}

/** "WSL2", "WSL", or undefined, from a kernel release string. */
export function wslOf(kernel: string | undefined): string | undefined {
  if (!kernel) return undefined;
  if (/wsl2/i.test(kernel)) return "WSL2";
  return /microsoft/i.test(kernel) ? "WSL" : undefined;
}

/**
 * The machine this session runs on as the model reads it: the OS, its arch and
 * kernel, and the shell the user's terminal uses. A line the machine cannot
 * answer — `$SHELL` is unset on Windows — is left out rather than guessed.
 */
export function platformSection(query: PlatformQuery = {}): string {
  const platform = query.platform ?? process.platform;
  const kernel = query.kernel ?? release();
  const shell = query.shell ?? process.env.SHELL;
  const details = [platform, query.arch ?? arch()];
  if (platform === "linux") details.push(libcOf(query));
  // A WSL kernel string says "WSL2" better than the raw number it carries.
  const wsl = platform === "linux" ? wslOf(kernel) : undefined;
  details.push(wsl ?? `kernel ${kernel}`);
  const lines = [`- OS: ${distroName(query.osRelease) ?? OS_NAMES[platform] ?? platform} (${details.join(", ")})`];
  // Where `$SHELL` points is the difference between ash and bash: /bin/sh is busybox on Alpine.
  if (shell) {
    const name = shell.split(/[\\/]/).pop() ?? shell;
    const target = query.shellLink?.split(/[\\/]/).pop();
    lines.push(`- Interactive terminal shell: ${name} (${shell}${target ? ` → ${target}` : ""})`);
  }
  return lines.join("\n");
}

function muslLoaderPath(): string {
  return `/lib/ld-musl-${MUSL_LOADER_ARCH[arch()] ?? arch()}.so.1`;
}

function readLink(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function machineQuery(): PlatformQuery {
  const query: PlatformQuery = {};
  if (process.platform === "linux") {
    try {
      query.osRelease = readRegularFileText(OS_RELEASE_PATH, OS_RELEASE_MAX_BYTES);
    } catch {
      // Not a regular file, or past the cap: the distro stays unnamed rather than guessed.
    }
    query.muslLoader = existsSync(muslLoaderPath());
  }
  const shell = process.env.SHELL;
  if (shell) {
    query.shell = shell;
    query.shellLink = readLink(shell);
  }
  return query;
}

/**
 * A normal session's own extension, as the bash stand-in is: always on, with no
 * `-builtin:` switch and nothing for a package to replace. It describes the machine whose
 * shell the `shellPath` default above picked, so the two cannot disagree.
 */
export function createPlatformInfoExtension(): InlineExtension {
  const section = platformSection(machineQuery());
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
