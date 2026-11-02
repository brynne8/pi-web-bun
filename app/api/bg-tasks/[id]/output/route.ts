import { readFile } from "node:fs/promises";
import { NextResponse } from "vinext/shims/server";
import { getBgTask } from "@/lib/bg-task-registry";
import type { BgTaskOutputResponse } from "@/lib/bg-task-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_TAIL_BYTES = 64 * 1024;

function readOffset(value: string | null): number | null {
  if (value === null) return null;
  const offset = Number(value);
  return Number.isInteger(offset) && offset >= 0 ? offset : null;
}

// GET /api/bg-tasks/[id]/output?offset=N - bytes appended since N, or the last `tail` bytes on the
// first read. Base64 keeps a multi-byte character split across two polls intact.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const task = getBgTask(id);
  if (!task || !task.logPath) {
    return NextResponse.json({ error: "Background task not found or expired" }, { status: 404 });
  }
  const url = new URL(request.url);
  const requestedOffset = readOffset(url.searchParams.get("offset"));
  const tail = readOffset(url.searchParams.get("tail")) ?? DEFAULT_TAIL_BYTES;
  let content: Buffer;
  try {
    content = await readFile(task.logPath);
  } catch {
    content = Buffer.alloc(0);
  }
  // A file shorter than the client's offset was replaced or truncated: start over rather than
  // sending nothing forever.
  const start = requestedOffset === null || requestedOffset > content.length
    ? Math.max(0, content.length - tail)
    : requestedOffset;
  const body: BgTaskOutputResponse = {
    id: task.id,
    offset: content.length,
    data: content.subarray(start).toString("base64"),
    running: task.finishedAtMs === null,
    task,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
