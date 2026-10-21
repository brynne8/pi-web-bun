import { homedir } from "os";

/**
 * The user's home folder as Node's `os.homedir()` resolves it: `$HOME` when set,
 * otherwise the user database. Bun's `os.homedir()` ignores `$HOME` and always reads
 * the database, so without this every home-based path — the agent directory, the
 * default cwd, the directory browser's root, `~` in a path — would follow the account
 * wherever the environment asked for another one (README: *Home directory*).
 */
export function homeDir(): string {
  return process.env.HOME || homedir();
}
