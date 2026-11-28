import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "vinext/shims/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  fileManagerPlatform,
  isFileManagerSupported,
  isLoopbackHost,
  launchFileManager,
} from "@/lib/open-in-file-manager";
import { errorMessage } from "@/lib/errors";

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

/**
 * `{ cwd }` opens the session workspace in the OS file manager; `{ reveal }`
 * shows a file or folder selected in its folder (a file row's menu).
 */
export async function POST(request: Request) {
  try {
    const { supported, reason } = availabilityFor(request);
    if (!supported) {
      return NextResponse.json({ error: reason }, { status: 403 });
    }

    const body = await request.json() as { cwd?: unknown; reveal?: unknown };
    // `reveal` shows one entry selected in its folder (a row's menu); without it
    // the target is a directory to open.
    const reveal = typeof body.reveal === "string" && body.reveal.trim() !== "";
    const requested = reveal ? body.reveal : body.cwd;
    if (typeof requested !== "string" || !requested.trim()) {
      return NextResponse.json({ error: "cwd-required" }, { status: 400 });
    }
    const target = resolve(requested);
    // Authorize before touching the path, so a location outside the allowed
    // roots answers 403 whether or not it exists.
    const roots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(target, roots)) {
      return NextResponse.json({ error: "access-denied" }, { status: 403 });
    }
    const stats = await stat(target);
    // A reveal shows any file or folder; without one the target must be a
    // directory, and nothing that is neither file nor folder is asked of the
    // file manager at all.
    if (reveal ? !stats.isFile() && !stats.isDirectory() : !stats.isDirectory()) {
      return NextResponse.json(
        { error: reveal ? "not-a-file" : "not-a-directory" },
        { status: 400 },
      );
    }

    await launchFileManager(target, process.platform, process.env, reveal);
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
