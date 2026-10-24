import fs from "fs";
import { NextRequest, NextResponse } from "vinext/shims/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { isGitWorkingPathAllowed } from "@/lib/git-path-access";
import { revertGitPath, type GitRevertResult } from "@/lib/git-revert";

/**
 * POST { cwd, path } — puts one changed file back to HEAD, in the index and in
 * the working tree. What the file row's Revert changes item runs.
 *
 * A refusal carries the `code` the item's message is chosen from (lib/git-revert-rule.ts).
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const record = (body ?? {}) as { cwd?: unknown; path?: unknown };
  const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
  const filePath = typeof record.path === "string" ? record.path.trim() : "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }
  if (!filePath || (!filePath.startsWith("/") && !isWindowsAbsolutePath(filePath))) {
    return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
  }

  try {
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    // The project root and the file are both checked, the file by its nearest
    // existing entry: a deleted file is absent, and a link inside the repository
    // can otherwise expose an outside file through an apparently local path.
    if (!isExistingFilePathAllowed(cwd, allowedRoots)
      || !isGitWorkingPathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const result: GitRevertResult = await revertGitPath(cwd, filePath);
    if (result.reverted) return NextResponse.json({ reverted: true, filePath: result.filePath });

    const status = result.code === "outside_repository" ? 403
      : result.code === "failed" ? 500
        : 409;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "failed" },
      { status: 500 },
    );
  }
}
