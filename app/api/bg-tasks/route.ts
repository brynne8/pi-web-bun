import { NextResponse } from "vinext/shims/server";
import { listBgTasks } from "@/lib/bg-task-registry";
import type { BgTaskListResponse } from "@/lib/bg-task-types";

export const dynamic = "force-dynamic";

// GET /api/bg-tasks - Live background bash tasks for the side panel: running first, then those
// that finished within the last ten minutes so their output can still be read.
export async function GET() {
  const tasks = listBgTasks();
  const body: BgTaskListResponse = {
    tasks,
    runningCount: tasks.filter((task) => task.finishedAtMs === null).length,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
