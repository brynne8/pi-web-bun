import { GIT_REVERT_REFUSAL_KEYS, type GitRevertRefusal } from "./git-revert-rule";

/**
 * The file row's Revert changes request, and how its answer becomes a toast.
 * Client-safe; the rule behind the item is lib/git-revert-rule.ts.
 */

export interface GitRevertOutcome {
  reverted: boolean;
  /** Why it did not happen; null on success and on a reply that said nothing. */
  code: GitRevertRefusal | null;
  /** Git's own words, shown only for a refusal the app has no sentence for. */
  error: string | null;
}

const REFUSAL_CODES = Object.keys(GIT_REVERT_REFUSAL_KEYS) as GitRevertRefusal[];

function asRefusalCode(value: unknown): GitRevertRefusal | null {
  return REFUSAL_CODES.includes(value as GitRevertRefusal) ? (value as GitRevertRefusal) : null;
}

/** Puts one file back to HEAD, in the index and in the working tree. */
export async function revertGitFileChanges(
  cwd: string,
  filePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitRevertOutcome> {
  try {
    const res = await fetchImpl("/api/git/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, path: filePath }),
    });
    const data = await res.json().catch(() => ({})) as { reverted?: unknown; code?: unknown; error?: unknown };
    if (res.ok && data.reverted === true) return { reverted: true, code: null, error: null };
    const error = typeof data.error === "string" ? data.error : res.ok ? null : `HTTP ${res.status}`;
    return { reverted: false, code: asRefusalCode(data.code) ?? "failed", error };
  } catch (error) {
    return {
      reverted: false,
      code: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
