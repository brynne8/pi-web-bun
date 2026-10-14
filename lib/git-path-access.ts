import { lstatSync } from "fs";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { hasParentDirectorySegment } from "./path-security";

/**
 * Authorizes one working-tree path for a Git action — a diff read, a revert —
 * given the roots the file API may already touch.
 *
 * The nearest *existing* entry is the one checked, because a deleted file (and
 * the directories that held it) is absent: walking up is what leaves a real entry
 * to judge. The walk never continues past a dangling link or an access error, and
 * the parent directory segments a `..` would carry are refused before any lookup.
 */
export function isGitWorkingPathAllowed(filePath: string, allowedRoots: Set<string>): boolean {
  if (hasParentDirectorySegment(filePath)) return false;
  let candidate = filePath;
  while (isFilePathAllowed(candidate, allowedRoots)) {
    try {
      lstatSync(candidate);
      return isExistingFilePathAllowed(candidate, allowedRoots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
  return false;
}
