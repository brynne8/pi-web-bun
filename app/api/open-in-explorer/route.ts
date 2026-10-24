import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "vinext/shims/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isFileManagerSupported, isLoopbackHost, launchFileManager } from "@/lib/open-in-file-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Whether this request may raise a file-manager window on the server. */
function availabilityFor(request: Request): { supported: boolean; reason: string | null } {
  if (!isLoopbackHost(request.headers.get("host"))) return { supported: false, reason: "remote" };
  if (!isFileManagerSupported(process.platform)) return { supported: false, reason: "unsupported-platform" };
  return { supported: true, reason: null };
}

/** Lets the sidebar pick the button label and disable it when unavailable. */
export async function GET(request: Request) {
  const { supported, reason } = availabilityFor(request);
  return NextResponse.json({ supported, reason, platform: process.platform });
}

/** Opens the session workspace, or reveals one file in it, in the OS file manager. */
export async function POST(request: Request) {
  try {
    const { supported, reason } = availabilityFor(request);
    if (!supported) {
      return NextResponse.json({ error: reason }, { status: 403 });
    }

    const body = await request.json() as { cwd?: unknown; revealFile?: unknown };
    // `revealFile` asks for one file to be selected among its folder's contents;
    // without it the target is a directory to open, as before.
    const revealFile = typeof body.revealFile === "string" && body.revealFile.trim()
      ? body.revealFile
      : null;
    if (!revealFile && (typeof body.cwd !== "string" || !body.cwd.trim())) {
      return NextResponse.json({ error: "cwd-required" }, { status: 400 });
    }
    const target = resolve(revealFile ?? body.cwd as string);
    // Authorize before touching the path, so a location outside the allowed
    // roots answers 403 whether or not it exists.
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(target, roots)) {
      return NextResponse.json({ error: "access-denied" }, { status: 403 });
    }
    const stats = await stat(target);
    if (revealFile) {
      // A directory here would be revealed as a folder icon, which is not what a
      // reveal of a row means; the caller passes a file path or opens the folder.
      if (!stats.isFile()) {
        return NextResponse.json({ error: "not-a-file" }, { status: 400 });
      }
    } else if (!stats.isDirectory()) {
      return NextResponse.json({ error: "not-a-directory" }, { status: 400 });
    }

    await launchFileManager(target, process.platform, revealFile ? "reveal" : "open");
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
