import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "vinext/shims/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  fileManagerPlatform,
  fileManagerViewFor,
  isFileManagerSupported,
  isLoopbackHost,
  launchFileManager,
} from "@/lib/open-in-file-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Whether this request may raise a file-manager window on the server. */
function availabilityFor(request: Request): { supported: boolean; reason: string | null; platform: string } {
  const platform = fileManagerPlatform();
  if (!isLoopbackHost(request.headers.get("host"))) return { supported: false, reason: "remote", platform };
  if (!isFileManagerSupported(platform)) return { supported: false, reason: "unsupported-platform", platform };
  return { supported: true, reason: null, platform };
}

/** Lets the sidebar pick the button label and disable it when unavailable. */
export async function GET(request: Request) {
  const { supported, reason, platform } = availabilityFor(request);
  // `platform` is which file manager the client's label should name: inside WSL it
  // is the Windows one, so the browser says Explorer, not a generic file manager.
  return NextResponse.json({ supported, reason, platform });
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
    // A row that turned out to be a folder opens that folder, and nothing that is
    // neither file nor folder is asked of the file manager at all.
    const view = fileManagerViewFor(revealFile !== null, stats);
    if (!view) {
      return NextResponse.json(
        { error: revealFile ? "not-a-file" : "not-a-directory" },
        { status: 400 },
      );
    }

    await launchFileManager(target, process.platform, view);
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
