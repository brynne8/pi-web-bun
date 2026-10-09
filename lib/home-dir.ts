import { homedir } from "os";

/**
 * The user's home folder, as `os.homedir()` resolves it on Node: `$HOME` when it
 * is set, otherwise the one from the user database. Node documents and honours
 * `$HOME`; Bun's `os.homedir()` ignores it and always reads the user database,
 * which on a fork that runs on Bun leaves every home-based path — the agent
 * dir, the default cwd, the directory browser's root, `~` in a path — pointing
 * at the account's own home even where the environment asks for another one
 * (a service manager, a container, the test fixtures). Resolving `$HOME` first
 * keeps both runtimes on the same rule.
 *
 * On Windows `$HOME` is normally unset, so the fallback applies there as it
 * does everywhere else.
 */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
