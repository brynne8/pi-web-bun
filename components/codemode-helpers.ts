import type {
  CodemodeInfo,
  CodemodeInlineBudgetInfo,
  CodemodeInlineBudgetSetting,
  CodemodeMode,
  CodemodeModeInfo,
  CodemodePreference,
  ToolSettingsResponse,
} from "@/lib/api-types";
import {
  isCwdRefusal,
  mcpEffectiveCodemodePreference,
  refusalFailure,
  withinDeadline,
  type FetchLike,
  type McpLoadFailure,
  type McpNoticeText,
} from "./mcp-config-helpers";

// What Settings › Tools shows of Code mode: the choice, the mode and the
// budget, the sandbox and the settings file that turns the built-in off.
// `GET/PUT /api/tools/settings` is the only route read and written here.

export const CODEMODE_PREFERENCE_KEYS: Record<CodemodePreference, string> = {
  automatic: "settings.codemode.automatic",
  always: "settings.codemode.always",
};

const CODEMODE_PROJECT_OVERRIDE_KEYS: Record<CodemodePreference, string> = {
  always: "settings.codemode.projectOverride.always",
  automatic: "settings.codemode.projectOverride.automatic",
};

/**
 * A trusted project whose `.pi/settings.json` `defaultTools` decides Code mode
 * for its sessions whatever the global choice, naming the file. Said whether or
 * not it agrees: changing the choice changes nothing there.
 */
export function codemodeProjectOverrideNotice(codemode: CodemodeInfo): McpNoticeText | undefined {
  const override = codemode.projectOverride;
  if (!override) return undefined;
  return { key: CODEMODE_PROJECT_OVERRIDE_KEYS[override.preference], params: { path: override.settingsPath } };
}

/**
 * Why Always on cannot be chosen: the sandbox failed its self-test (nothing in
 * Settings fixes that), or the global `extensions` turn the built-in off, which
 * a global setting depends on everywhere. A project's own switch does not count.
 */
export function codemodeAlwaysUnavailableNotice(codemode: CodemodeInfo): McpNoticeText | undefined {
  if (codemode.sandbox.state === "unavailable") return { key: "settings.codemode.alwaysUnavailable.sandbox" };
  if (!codemode.globalBuiltinSettingsPath) return undefined;
  return { key: "settings.codemode.alwaysUnavailable.builtin", params: { path: codemode.globalBuiltinSettingsPath } };
}

/** `-builtin:codemode` turns Code mode off for this project's sessions (or everywhere, under the global file). */
export function codemodeBuiltinNotice(codemode: CodemodeInfo): McpNoticeText | undefined {
  if (!codemode.builtinDisabled) return undefined;
  const path = codemode.builtinSettingsPath;
  if (!path) return { key: "settings.codemode.builtinDisabledUnknown" };
  return codemode.globalBuiltinSettingsPath
    ? { key: "settings.codemode.builtinDisabled", params: { path } }
    : { key: "settings.codemode.builtinDisabledProject", params: { path } };
}

export const CODEMODE_MODE_KEYS: Record<CodemodeMode, string> = {
  on: "settings.codemode.toolMode.on",
  only: "settings.codemode.toolMode.only",
};

export const CODEMODE_MODE_DESCRIPTION_KEYS: Record<CodemodeMode, string> = {
  on: "settings.codemode.toolMode.onDescription",
  only: "settings.codemode.toolMode.onlyDescription",
};

const CODEMODE_MODE_PROJECT_OVERRIDE_KEYS: Record<CodemodeMode, string> = {
  on: "settings.codemode.toolMode.projectOverride.on",
  only: "settings.codemode.toolMode.projectOverride.only",
};

/**
 * Whether choosing `value` changes the global settings: another mode, or
 * either one over a stored value pi reads as "on" without it being a mode,
 * which saving replaces.
 */
export function codemodeModeChanges(mode: CodemodeModeInfo, value: CodemodeMode): boolean {
  return value !== mode.value || mode.invalid !== undefined;
}

/**
 * The lines under the mode switch: a global value pi reads as "on" without it
 * being a mode; a trusted project whose settings give its sessions their own
 * mode; and "only" under Automatic, which calls these tools directly until a
 * server turns Code mode on.
 */
export function codemodeModeNotices(codemode: CodemodeInfo): McpNoticeText[] {
  const mode = codemode.mode;
  if (!mode) return [];
  const notices: McpNoticeText[] = [];
  if (mode.invalid !== undefined) {
    notices.push({ key: "settings.codemode.toolMode.invalid", params: { path: mode.settingsPath, value: mode.invalid } });
  }
  const project = mode.projectOverride;
  if (project) {
    notices.push({ key: CODEMODE_MODE_PROJECT_OVERRIDE_KEYS[project.value], params: { path: project.settingsPath } });
  }
  if ((project ?? mode).value === "only" && mcpEffectiveCodemodePreference(codemode) === "automatic") {
    notices.push({ key: "settings.codemode.toolMode.automaticNote" });
  }
  return notices;
}

/** The budget field's text for a stored value: empty for pi's default, which the placeholder shows. */
export function codemodeInlineBudgetDraftOf(budget: Pick<CodemodeInlineBudgetInfo, "value">): string {
  return budget.value === undefined ? "" : String(budget.value);
}

/** What the budget field asks to save: a whole number up to `max`, or null (empty) for pi's default. */
export type CodemodeInlineBudgetDraft = { ok: true; value: number | null } | { ok: false };

export function parseCodemodeInlineBudgetDraft(text: string, max: number): CodemodeInlineBudgetDraft {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return value <= max ? { ok: true, value } : { ok: false };
}

/**
 * Whether saving the draft changes the global settings: a different budget,
 * or an empty field over a value pi ignores, which saving removes.
 */
export function codemodeInlineBudgetDraftChanges(budget: CodemodeInlineBudgetInfo, draft: CodemodeInlineBudgetDraft): boolean {
  if (!draft.ok) return false;
  if (draft.value === null) return budget.value !== undefined || budget.invalid !== undefined;
  return draft.value !== budget.value;
}

/**
 * The warnings under the budget field: a global value pi ignores, and a
 * trusted project whose settings give its sessions their own budget (said
 * whether or not it agrees, as for the Code mode choice).
 */
export function codemodeInlineBudgetNotices(budget: CodemodeInlineBudgetInfo): McpNoticeText[] {
  const notices: McpNoticeText[] = [];
  if (budget.invalid !== undefined) {
    notices.push({
      key: "settings.codemode.inlineBudget.invalid",
      params: { path: budget.settingsPath, value: budget.invalid, default: String(budget.default) },
    });
  }
  const project = budget.projectOverride;
  if (project) {
    notices.push(project.value !== undefined
      ? { key: "settings.codemode.inlineBudget.projectOverride", params: { path: project.settingsPath, value: String(project.value) } }
      : { key: "settings.codemode.inlineBudget.projectOverrideDefault", params: { path: project.settingsPath, default: String(budget.default) } });
  }
  return notices;
}

// ---------------------------------------------------------------------------
// GET and PUT /api/tools/settings
// ---------------------------------------------------------------------------

/** How long a load or a save may take; the panel's controls wait while one runs. */
export const CODEMODE_SETTINGS_TIMEOUT_MS = 15_000;

/** Which write is on its way, so the row it was made from shows its progress and failure. */
export interface CodemodeSaveState {
  saving: boolean;
  error: McpLoadFailure | null;
  target?: "preference" | "mode" | "inlineBudget";
}

export type CodemodeLoadResult =
  | {
      ok: true;
      codemode: CodemodeInfo;
      /** The route refused the project folder, so only the global settings were read. */
      projectError?: McpLoadFailure;
    }
  | { ok: false; error: McpLoadFailure };

export type CodemodeSaveResult = { ok: true; codemode: CodemodeInfo } | { ok: false; error: McpLoadFailure };

/** The route's URL for `cwd`'s settings; without one, the global settings alone. */
export function codemodeSettingsUrl(cwd: string | null): string {
  return cwd ? `/api/tools/settings?cwd=${encodeURIComponent(cwd)}` : "/api/tools/settings";
}

function isCodemodeInfo(value: unknown): value is CodemodeInfo {
  if (value === null || typeof value !== "object") return false;
  const info = value as Partial<CodemodeInfo>;
  return typeof info.builtinDisabled === "boolean" && typeof info.sandbox === "object" && info.sandbox !== null;
}

function isToolSettings(value: unknown): value is ToolSettingsResponse {
  return value !== null && typeof value === "object" && isCodemodeInfo((value as Partial<ToolSettingsResponse>).codemode);
}

async function requestCodemode(cwd: string | null, fetchImpl: FetchLike, signal?: AbortSignal): Promise<CodemodeLoadResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(codemodeSettingsUrl(cwd), { cache: "no-store", signal });
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: `HTTP ${response.status}` } };
  }
  if (response.ok && isToolSettings(data)) return { ok: true, codemode: data.codemode };
  return { ok: false, error: refusalFailure(data, response.status) };
}

async function loadWithin(cwd: string | null, fetchImpl: FetchLike, signal: AbortSignal): Promise<CodemodeLoadResult> {
  const first = await requestCodemode(cwd, fetchImpl, signal);
  if (first.ok || !cwd || !isCwdRefusal(first.error.reason)) return first;
  const global = await requestCodemode(null, fetchImpl, signal);
  return global.ok ? { ...global, projectError: first.error } : global;
}

/**
 * Loads Code mode for the page's project, or the global settings alone without
 * one. A project folder the route refuses does not hide the global choice: it is
 * loaded again without it, and the refusal is kept so the page knows its saves
 * must be global too. The whole load ends by `timeoutMs`.
 */
export async function loadCodemodeInfo(
  cwd: string | null,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  timeoutMs: number = CODEMODE_SETTINGS_TIMEOUT_MS,
): Promise<CodemodeLoadResult> {
  return withinDeadline<CodemodeLoadResult>(
    (deadlineSignal) => loadWithin(cwd, fetchImpl, deadlineSignal),
    () => ({ ok: false, error: { error: `GET /api/tools/settings did not answer within ${timeoutMs} ms`, timedOut: true } }),
    timeoutMs,
    signal,
  );
}

/**
 * One change through `PUT /api/tools/settings`, answered with the settings as
 * the route read them back after writing. `cwd` only widens that read-back
 * (the project's overrides); every change itself is global.
 */
async function requestCodemodeChange(
  change: Record<string, unknown>,
  cwd: string | null,
  fetchImpl: FetchLike,
  signal: AbortSignal,
): Promise<CodemodeSaveResult> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(codemodeSettingsUrl(cwd), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: `HTTP ${response.status}` } };
  }
  if (response.ok && isToolSettings(data)) return { ok: true, codemode: data.codemode };
  return { ok: false, error: refusalFailure(data, response.status) };
}

async function saveWithin(
  change: Record<string, unknown>,
  cwd: string | null,
  fetchImpl: FetchLike,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<CodemodeSaveResult> {
  return withinDeadline<CodemodeSaveResult>(
    (deadlineSignal) => requestCodemodeChange(change, cwd, fetchImpl, deadlineSignal),
    () => ({ ok: false, error: { error: `PUT /api/tools/settings did not answer within ${timeoutMs} ms`, timedOut: true } }),
    timeoutMs,
    signal,
  );
}

/**
 * Saves the Code mode choice through `PUT /api/tools/settings`, the only
 * writer of the global `defaultTools` (it shares its lock with the PowerShell
 * switch). A timed-out save may still land, so the page loads again either way.
 */
export async function saveCodemodePreference(
  preference: CodemodePreference,
  cwd: string | null,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  timeoutMs: number = CODEMODE_SETTINGS_TIMEOUT_MS,
): Promise<CodemodeSaveResult> {
  return saveWithin({ codemode: preference }, cwd, fetchImpl, signal ?? new AbortController().signal, timeoutMs);
}

/** Saves the global `codemode.mode`; "on" is pi's default, so it removes the key. */
export async function saveCodemodeMode(
  mode: CodemodeMode,
  cwd: string | null,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  timeoutMs: number = CODEMODE_SETTINGS_TIMEOUT_MS,
): Promise<CodemodeSaveResult> {
  return saveWithin({ codemodeMode: mode }, cwd, fetchImpl, signal ?? new AbortController().signal, timeoutMs);
}

/** Saves the global `codemode.inlineBudget`; null removes it, giving sessions pi's default. */
export async function saveCodemodeInlineBudget(
  budget: number | null,
  cwd: string | null,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  signal?: AbortSignal,
  timeoutMs: number = CODEMODE_SETTINGS_TIMEOUT_MS,
): Promise<CodemodeSaveResult> {
  return saveWithin({ codemodeInlineBudget: budget }, cwd, fetchImpl, signal ?? new AbortController().signal, timeoutMs);
}
