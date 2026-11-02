import { NextResponse } from "vinext/shims/server";
import { getBgTask, killBgTask } from "@/lib/bg-task-registry";
import { BG_TASK_KILLED_CUSTOM_TYPE, buildBgTaskKilledNote } from "@/lib/bg-task-notification";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/bg-tasks/[id] { action: "kill" } - stop one running background bash task and leave the
// session a note saying a person stopped it, so the model does not keep waiting for a result.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({})) as { action?: unknown };
    if (body.action !== "kill") {
      return NextResponse.json({ error: "Unsupported background task action" }, { status: 400 });
    }
    const task = getBgTask(id);
    if (!task) {
      return NextResponse.json({ error: "Background task not found or already finished" }, { status: 404 });
    }
    const stopped = killBgTask(id);
    if (!stopped) {
      return NextResponse.json({ error: "Background task not found or already finished" }, { status: 404 });
    }
    // The abort is what stops the process; the note is best effort, never a reason to report a
    // failed stop after the process is already gone.
    let notified = false;
    try {
      let session = getRpcSession(stopped.sessionId);
      if (!session?.isAlive()) {
        const sessionFile = await resolveSessionPath(stopped.sessionId);
        if (sessionFile) session = (await startRpcSession(stopped.sessionId, sessionFile, undefined)).session;
      }
      if (session?.isAlive()) {
        await session.waitUntilReady();
        await session.inner.sendCustomMessage({
          customType: BG_TASK_KILLED_CUSTOM_TYPE,
          content: buildBgTaskKilledNote(stopped),
          display: true,
        }, { deliverAs: "followUp", triggerTurn: false });
        notified = true;
      }
    } catch (error) {
      console.error("[pi-web] failed to note a stopped background task:", error instanceof Error ? error.message : error);
    }
    return NextResponse.json({ success: true, notified });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
