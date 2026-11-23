import { readFileSync } from "node:fs";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptSources } from "./append-system-prompt.ts";

/** One prompt text file, in the shape the SDK's own discovery hands one over. */
export interface PromptTextFile {
  path: string;
  content: string;
}

/** The prompt text a session's loader holds, re-read from disk. */
export interface PromptTextSources {
  /** `APPEND_SYSTEM.md`: the project file while its folder is trusted, else the global one. */
  appendSystemPrompt: string[];
  /** `AGENTS.md`: the global file and every ancestor's, in the SDK's own order. */
  contextFiles: PromptTextFile[];
}

/**
 * The loader surface a prompt-text refresh reads and writes. `cwd`, `agentDir` and the data fields
 * are public at runtime and private in the SDK's types, so the shape is named here rather than
 * reached for through a cast at each use.
 */
export interface PromptSourcesLoader {
  readonly cwd: string;
  readonly agentDir: string;
  readonly noContextFiles: boolean;
  /** Set when the session was built with its own prompt text, which the refresh then leaves alone. */
  readonly appendSystemPromptSource?: readonly string[];
  /** Set when the context files were narrowed for the session, as a subagent's are. */
  readonly agentsFilesOverride?: unknown;
  readonly settingsManager: { isProjectTrusted(): boolean };
  appendSystemPrompt: string[];
  agentsFiles: PromptTextFile[];
}

/** As the loader reads a prompt file: UTF-8, with a byte order mark taken off. */
function readPromptText(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

/**
 * The prompt text as the files on disk read now: `APPEND_SYSTEM.md` under the precedence the SDK's
 * own `discoverAppendSystemPromptFile()` uses (`appendSystemPromptSources()`), and the `AGENTS.md`
 * files the SDK's own `loadProjectContextFiles()` discovers. Nothing is re-derived here, so a
 * discovery change upstream reaches this through the SDK rather than through a copy of its rules.
 */
export function readPromptTextSources(loader: PromptSourcesLoader): PromptTextSources {
  const projectTrusted = loader.settingsManager.isProjectTrusted();
  return {
    appendSystemPrompt: appendSystemPromptSources(loader.cwd, loader.agentDir, projectTrusted)
      .map(readPromptText),
    contextFiles: loader.noContextFiles
      ? []
      : loadProjectContextFiles({ cwd: loader.cwd, agentDir: loader.agentDir }),
  };
}

/**
 * Write the freshly read prompt text into the loader, so the base prompt pi renders for the next
 * request carries it.
 *
 * Only what the loader discovered itself is written: a session built with its own prompt text (a
 * subagent's append text, Chat only's placeholders) or with a narrowed context-file list keeps
 * what it was built with, and a loader that reads no context files keeps reading none.
 */
export function refreshLoaderPromptText(loader: PromptSourcesLoader): void {
  const sources = readPromptTextSources(loader);
  if (loader.appendSystemPromptSource === undefined) {
    loader.appendSystemPrompt = sources.appendSystemPrompt;
  }
  if (!loader.noContextFiles && loader.agentsFilesOverride === undefined) {
    loader.agentsFiles = sources.contextFiles;
  }
}
