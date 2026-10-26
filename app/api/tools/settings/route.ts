import { NextResponse } from "vinext/shims/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CodemodeInfo, McpErrorResponse, McpRefusalReason, ToolSettingsResponse } from "@/lib/api-types";
import {
  CODEMODE_INLINE_BUDGET_MAX,
  isCodemodeInlineBudget,
  isCodemodeMode,
  isCodemodePreference,
  writeCodemodeInlineBudget,
  writeCodemodeMode,
  writeCodemodePreference,
} from "@/lib/codemode-settings";
import { readCodemodeInfo } from "@/lib/codemode-info";
import { readBuiltinExtensionSwitches, type BuiltinExtensionSwitch } from "@/lib/builtin-extensions";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readBgTasksEnabled, writeBgTasksEnabled } from "@/lib/bg-tasks-settings";
import { isMcpEntryRefusal, validateMcpProject } from "@/lib/mcp-entry-request";
import {
  readPowerShellToolEnabled,
  writePowerShellToolEnabled,
} from "@/lib/powershell-settings";
import { getProjectTrustStatus } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

// Settings › Tools, and the only writer of the global `defaultTools` key: the
// PowerShell switch (Windows) and the Code mode choice (ADR 0006) both edit it,
// under the lock pi's SettingsManager takes on the same file. The global
// `codemode.mode` and `codemode.inlineBudget` are saved here too, under the
// same lock. `?cwd=` names the project the page describes: its `.pi/settings.json`
// may decide Code mode for its own sessions, and that is read only when the
// project's settings load (a trusted folder).
//
// Every refusal carries a `reason` code the panel translates, beside the
// English `error` it shows only as the diagnostic of an `internal` failure.

const CHANGES = ["enabled", "codemode", "codemodeMode", "codemodeInlineBudget", "bgTasksEnabled"] as const;

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, "internal", error instanceof Error ? error.message : String(error));
}

/** Whether sessions in `cwd` load its `.pi/settings.json`; an unreadable trust store trusts nothing. */
function projectSettingsLoad(cwd: string, agentDir: string): boolean {
  try {
    return getProjectTrustStatus(cwd, agentDir).trusted === true;
  } catch {
    return false;
  }
}

async function readCodemode(cwd: string | undefined, agentDir: string): Promise<CodemodeInfo> {
  const trustedCwd = cwd !== undefined && projectSettingsLoad(cwd, agentDir) ? cwd : undefined;
  let builtinSwitch: BuiltinExtensionSwitch | undefined;
  try {
    ({ codemode: builtinSwitch } = await readBuiltinExtensionSwitches({
      agentDir,
      cwd,
      projectTrusted: trustedCwd !== undefined,
    }));
  } catch (error) {
    // A settings file that cannot be read leaves the built-in as the session would find it: on.
    console.warn(`[pi-web] cannot read the extensions settings for Settings › Tools: ${error instanceof Error ? error.message : String(error)}`);
  }
  return readCodemodeInfo({ agentDir, builtinSwitch, trustedCwd });
}

async function readToolSettings(cwd: string | undefined): Promise<ToolSettingsResponse> {
  const agentDir = getAgentDir();
  // One after the other: each takes the file lock, and a reader that finds it
  // held backs off for about a second.
  const powerShellEnabled = await readPowerShellToolEnabled();
  const bgTasksEnabled = await readBgTasksEnabled();
  const codemode = await readCodemode(cwd, agentDir);
  return { isWindows: process.platform === "win32", powerShellEnabled, bgTasksEnabled, codemode };
}

/** The `?cwd=` project, checked as Settings › MCP checks it, or a refusal to answer with. */
async function requestCwd(req: Request): Promise<{ cwd?: string; refused?: NextResponse }> {
  const value = new URL(req.url).searchParams.get("cwd");
  if (value === null) return {};
  const result = await validateMcpProject(value);
  if (isMcpEntryRefusal(result)) return { refused: NextResponse.json(result.body, { status: result.status }) };
  return { cwd: result.cwd };
}

export async function GET(req: Request) {
  try {
    const { cwd, refused } = await requestCwd(req);
    if (refused) return refused;
    return NextResponse.json(await readToolSettings(cwd));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "request-denied", "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "content-type", "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "invalid-request", "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as { enabled?: unknown; codemode?: unknown; codemodeMode?: unknown; codemodeInlineBudget?: unknown; bgTasksEnabled?: unknown };
  if (CHANGES.filter((key) => key in changes).length !== 1) {
    return refusal(400, "invalid-request", "Send one of enabled (PowerShell), codemode, codemodeMode, codemodeInlineBudget or bgTasksEnabled");
  }

  let cwd: string | undefined;
  try {
    const requested = await requestCwd(req);
    if (requested.refused) return requested.refused;
    cwd = requested.cwd;
  } catch (error) {
    return errorResponse(error);
  }

  if ("bgTasksEnabled" in changes) {
    if (typeof changes.bgTasksEnabled !== "boolean") {
      return refusal(400, "invalid-request", "bgTasksEnabled must be a boolean");
    }
    try {
      await writeBgTasksEnabled(changes.bgTasksEnabled);
      return NextResponse.json(await readToolSettings(cwd));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemodeMode" in changes) {
    // "on" removes the key: it is pi's default.
    if (!isCodemodeMode(changes.codemodeMode)) {
      return refusal(400, "invalid-request", "codemodeMode must be \"on\" or \"only\"");
    }
    try {
      await writeCodemodeMode(changes.codemodeMode);
      return NextResponse.json(await readToolSettings(cwd));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemodeInlineBudget" in changes) {
    // null removes the key, which gives sessions pi's default.
    const budget = changes.codemodeInlineBudget;
    if (budget !== null && !isCodemodeInlineBudget(budget)) {
      return refusal(400, "invalid-request", `codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`);
    }
    try {
      await writeCodemodeInlineBudget(budget ?? undefined);
      return NextResponse.json(await readToolSettings(cwd));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if ("codemode" in changes) {
    if (!isCodemodePreference(changes.codemode)) {
      return refusal(400, "invalid-request", "codemode must be \"automatic\" or \"always\"");
    }
    try {
      await writeCodemodePreference(changes.codemode);
      return NextResponse.json(await readToolSettings(cwd));
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (process.platform !== "win32") {
    return refusal(404, "invalid-request", "PowerShell tool settings are only available on Windows");
  }
  if (typeof changes.enabled !== "boolean") {
    return refusal(400, "invalid-request", "enabled must be a boolean");
  }
  try {
    await writePowerShellToolEnabled(changes.enabled);
    return NextResponse.json(await readToolSettings(cwd));
  } catch (error) {
    return errorResponse(error);
  }
}
