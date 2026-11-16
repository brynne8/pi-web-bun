/**
 * Display-only path shortening for the settings panels. Nothing reads these
 * strings back: authorization and API calls always use the full path.
 */

/** A path with a macOS or Linux home folder shown as `~`. */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/**
 * A path inside `root` as it is written from there (`src/x.ts`), else `null`.
 * A literal prefix match, `/` only: a path that does not match is left to the caller.
 */
export function relativeToRoot(path: string, root: string | undefined): string | null {
  const base = root?.replace(/\/+$/, "");
  if (!base || !path.startsWith(`${base}/`)) return null;
  return path.slice(base.length + 1);
}

/**
 * A path inside `root` as `./relative`, anything else as `shortenPath()`.
 * Only a whole leading folder counts, so `/repo-other/x` is not inside `/repo`.
 */
export function displayPathWithin(path: string, root: string): string {
  const base = root.replace(/[/\\]+$/, "");
  if (base && (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))) {
    return `./${path.slice(base.length).replace(/^[/\\]/, "")}`;
  }
  return shortenPath(path);
}
