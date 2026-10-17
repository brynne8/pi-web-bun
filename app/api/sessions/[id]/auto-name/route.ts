import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { autoNameDeclines, appendSessionNameSource, readSessionNameRecord } from "@/lib/session-name-source";
import { invalidateSessionListCache, openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import type { SessionEntry } from "@/lib/types";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // A name a person chose is theirs: auto-naming declines rather than replace it.
    // Read the file, not the wrapper: a rename through PATCH appends to it through
    // its own SessionManager, so the wrapper's copy of the name can be older.
    const namedBefore = readSessionNameRecord(openSessionManager(filePath).getEntries() as unknown as SessionEntry[]);
    if (autoNameDeclines(namedBefore)) {
      return NextResponse.json({ title: namedBefore.name, declined: "user" });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    // A name that changed while the title model ran (a rename in another tab) wins.
    const namedAfter = readSessionNameRecord(openSessionManager(filePath).getEntries() as unknown as SessionEntry[]);
    if (autoNameDeclines(namedAfter)) {
      return NextResponse.json({ title: namedAfter.name, declined: "user" });
    }

    session.inner.setSessionName(result.title);
    appendSessionNameSource(session.inner.sessionManager, result.title, "auto");
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
