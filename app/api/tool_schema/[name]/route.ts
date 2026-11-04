import { NextResponse } from "vinext/shims/server";
import type { ToolInfo } from "@/lib/pi-types";
import { getRpcSession, getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Every tool a running session declares, by lowercase name: the same list the tools menu reads.
// A callable declaration wins over a withdrawn one; a session that cannot describe its tools is
// skipped rather than failing the answer.
function allTools(): Map<string, ToolInfo> {
  const tools = new Map<string, ToolInfo>();
  for (const id of getRunningRpcSessionIds()) {
    try {
      for (const tool of getRpcSession(id)?.inner.getAllTools() ?? []) {
        const key = tool.name.toLowerCase();
        if (tools.get(key)?.exposure !== "hidden") continue;
        tools.set(key, tool);
      }
    } catch {
      // A session mid-shutdown has no tool list to read.
    }
  }
  return tools;
}

// GET /api/tool_schema/[name] - one tool's definition: its description and its JSON schema,
// parameter descriptions included. A blocked call is answered with this route, so the model reads
// the fields instead of guessing them. The name matches without case.
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const tool = allTools().get(decodeURIComponent(name).trim().toLowerCase());
  if (!tool) {
    return NextResponse.json(
      { error: `No running session declares a tool named "${name}"` },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters,
      exposure: tool.exposure ?? "direct",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
