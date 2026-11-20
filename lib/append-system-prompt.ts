import { existsSync } from "node:fs";
import { join } from "node:path";

/** The file pi appends to a session's prompt, under `<cwd>/.pi` and at the agent dir's root. */
const APPEND_SYSTEM_FILE = "APPEND_SYSTEM.md";
const PI_CONFIG_DIR = ".pi";

/**
 * The `APPEND_SYSTEM.md` paths a session's loader discovers itself: the project file when its
 * folder is trusted, else the global one, at most one — the precedence of the SDK's own
 * `discoverAppendSystemPromptFile()` (`lib/project-trust.ts` keeps the `.pi` spelling). Only
 * existing paths are returned: the loader sends a path it cannot read as literal prompt text.
 * Subagents switch that discovery off with their own `appendSystemPrompt`, so they call this too.
 */
export function appendSystemPromptSources(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): string[] {
  const projectPath = cwd ? join(cwd, PI_CONFIG_DIR, APPEND_SYSTEM_FILE) : undefined;
  if (projectPath && projectTrusted && existsSync(projectPath)) return [projectPath];
  const globalPath = join(agentDir, APPEND_SYSTEM_FILE);
  return existsSync(globalPath) ? [globalPath] : [];
}
