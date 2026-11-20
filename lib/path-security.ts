import fs from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "./paths.ts";

/**
 * Lexical containment check. Accepts either canonical form on both sides: it
 * re-resolves through path.win32/path.posix and case-folds on Windows, so
 * separator style and drive-letter case never decide the answer.
 */
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    if (isPathWithinRoot(target, root)) return true;
  }
  return false;
}

function isPathWithinRoot(target: string, root: string): boolean {
  const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
  const resolver = useWindowsRules ? path.win32 : path;
  const sep = useWindowsRules ? "\\" : path.sep;
  const normalized = resolver.resolve(target);
  const normalizedRoot = resolver.resolve(root);
  const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
  const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
  const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparable === comparableRoot || comparable.startsWith(rootWithSep);
}

function resolveRealRoot(root: string): string | undefined {
  try {
    return fs.realpathSync(root);
  } catch {
    // Ignore stale roots derived from removed sessions or worktrees.
    return undefined;
  }
}

/** The roots after resolving symbolic links, for comparing canonical paths. */
export function resolveRealRoots(roots: Set<string>): Set<string> {
  const realRoots = new Set<string>();
  for (const root of roots) {
    const realRoot = resolveRealRoot(root);
    if (realRoot !== undefined) realRoots.add(realRoot);
  }
  return realRoots;
}

/**
 * Whether `target` has a `..` segment. Node's realpathSync collapses `..`
 * before it follows links, while the filesystem applies it after, so
 * `root/link/..` authorizes as `root` but opens the directory holding the
 * link's target, outside the roots (#748). A backslash separates segments only
 * in Windows paths; elsewhere it is part of a file name.
 */
export function hasParentDirectorySegment(target: string): boolean {
  const separator = process.platform === "win32" || isWindowsAbsolutePath(target) ? /[\\/]/ : "/";
  return target.split(separator).includes("..");
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  if (hasParentDirectorySegment(target)) return false;
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    // Bun's realpathSync reads the file, where Node's walks directories only: a file
    // without read permission throws EACCES on Bun and names its real path on Node.
    // The last component is then the only one left unaccounted for, and a name that
    // is not a link cannot carry the path out of its parent — so the parent answers
    // for it, exactly as Node's own realpath would have. A link may point anywhere,
    // so it stays refused, as does a parent that does not resolve.
    try {
      if (fs.lstatSync(target).isSymbolicLink()) return false;
      realTarget = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return false;
    }
  }
  function matchesRealRoot(root: string): boolean {
    const realRoot = resolveRealRoot(root);
    return realRoot !== undefined && isPathWithinRoot(realTarget, realRoot);
  }

  // Lexical containment only orders the checks; a symlink can land in another root.
  const remainingRoots: string[] = [];
  for (const root of roots) {
    if (isPathWithinRoot(target, root)) {
      if (matchesRealRoot(root)) return true;
    } else {
      remainingRoots.push(root);
    }
  }
  return remainingRoots.some(matchesRealRoot);
}
