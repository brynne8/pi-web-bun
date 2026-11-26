import { sanitizeProjectCommandEnvironment } from "./project-environment.ts";

/**
 * The environment of a git child that runs in the user's project folder: the
 * host's without `PORT`, `NODE_ENV`, `NEXT_*` and `PI_WEB_PASSWORD` (ADR 0001),
 * with the message locale pinned to `C`. Git runs hooks the repository's own
 * config names (`core.fsmonitor`) and they inherit this environment.
 */
export function projectGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...sanitizeProjectCommandEnvironment(base), LC_ALL: "C" };
}

/**
 * The same for a child that only reads. `GIT_OPTIONAL_LOCKS=0` keeps it out of
 * `.git/index.lock`: `git status` takes the lock to write back a refreshed stat
 * cache, and a listing that changed nothing has nothing to write, so that lock is
 * held for the whole scan and refuses a `git commit` that lands inside it.
 */
export function readOnlyGitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...projectGitEnvironment(base), GIT_OPTIONAL_LOCKS: "0" };
}
