import type { CodemodeInfo, CodemodeSandboxStatus } from "./api-types";
import { peekCodemodeSandbox, type BuiltinExtensionSwitch } from "./builtin-extensions";
import {
  CODEMODE_INLINE_BUDGET_DEFAULT,
  CODEMODE_INLINE_BUDGET_MAX,
  readCodemodePreference,
  readCodemodeSettings,
  readProjectCodemodeInlineBudget,
  readProjectCodemodeMode,
  readProjectCodemodeOverride,
} from "./codemode-settings";
import { getGlobalSettingsPath } from "./global-settings-file";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CodemodeInfoOptions {
  agentDir: string;
  /** The `codemode` built-in switch, as `readBuiltinExtensionSwitches()` read it for this project. */
  builtinSwitch?: BuiltinExtensionSwitch;
  /** The project whose settings its sessions read (a trusted one): its overrides are read from it. */
  trustedCwd?: string;
}

/**
 * Code mode as a session would get it: the global preference, mode and inline
 * budget, the sandbox self-test and `-builtin:codemode` (both as the project's
 * sessions see it and as the global settings alone say), and, given
 * `trustedCwd`, the project settings that decide any of them there whatever
 * the global value.
 */
export async function readCodemodeInfo({ agentDir, builtinSwitch, trustedCwd }: CodemodeInfoOptions): Promise<CodemodeInfo> {
  const peek = await peekCodemodeSandbox();
  const sandbox: CodemodeSandboxStatus = !peek.checked
    ? { state: "not-checked" }
    : peek.available
      ? { state: "available" }
      : { state: "unavailable", error: peek.reason };
  const info: CodemodeInfo = { sandbox, builtinDisabled: builtinSwitch?.enabled === false };
  if (builtinSwitch?.settingsPath) info.builtinSettingsPath = builtinSwitch.settingsPath;
  // What the global `extensions` alone say, which is what Always on, a global setting, depends on.
  const globalSwitch = builtinSwitch?.global ?? builtinSwitch;
  if (globalSwitch?.enabled === false) {
    info.globalBuiltinSettingsPath = globalSwitch.settingsPath ?? getGlobalSettingsPath(agentDir);
  }
  try {
    info.preference = await readCodemodePreference(getGlobalSettingsPath(agentDir));
  } catch (error) {
    info.preferenceError = errorMessage(error);
  }
  const projectOverride = trustedCwd === undefined ? undefined : readProjectCodemodeOverride(trustedCwd);
  if (projectOverride) info.projectOverride = projectOverride;
  // Read on its own: a malformed defaultTools leaves the codemode object readable, and the other way round.
  try {
    const settingsPath = getGlobalSettingsPath(agentDir);
    const { mode, inlineBudget } = await readCodemodeSettings(settingsPath);
    info.mode = { ...mode, settingsPath };
    const projectMode = trustedCwd === undefined ? undefined : readProjectCodemodeMode(trustedCwd);
    if (projectMode) info.mode.projectOverride = projectMode;
    info.inlineBudget = { ...inlineBudget, settingsPath, default: CODEMODE_INLINE_BUDGET_DEFAULT, max: CODEMODE_INLINE_BUDGET_MAX };
    const projectBudget = trustedCwd === undefined ? undefined : readProjectCodemodeInlineBudget(trustedCwd);
    if (projectBudget) info.inlineBudget.projectOverride = projectBudget;
  } catch (error) {
    info.modeError = errorMessage(error);
    info.inlineBudgetError = info.modeError;
  }
  return info;
}
