/**
 * One table over every kind of background work a session started: the tool's name, its row shape,
 * and the answer `list_bg_runs` prints.
 *
 * A row carries its subsystem's own state word, because "succeeded" and "completed" are different
 * facts in the two of them; the `kind` column says which vocabulary to read.
 */

/** The tool that reads this table. */
export const LIST_BG_RUNS_TOOL_NAME = "list_bg_runs";

/** Which subsystem produced the run. The same words `await_results` lists results under. */
export type BgRunKind = "bash" | "subagent";

/** One row: what to fetch it with, how it is going, and what it was for. */
export interface BgRunEntry {
  kind: BgRunKind;
  /** Exactly what `get_result` takes: a command's `bash-<8hex>` handle, or a subagent's short id. */
  id: string;
  /** The run's own status word, in its subsystem's vocabulary. */
  state: string;
  /** ISO timestamp of the last thing that happened to the run. */
  lastActivityAt: string;
  /** A command's first line, or a subagent's `profile: description`. */
  description: string;
}

/** The TSV header: one line, one entry per settled run. */
const BG_RUN_HEADER = "id\tkind\tstate\tlast_activity\tdescription";

/** Still going, per subsystem. */
const BG_RUN_ACTIVE_STATES: Record<BgRunKind, ReadonlySet<string>> = {
  bash: new Set(["running", "stopping"]),
  subagent: new Set(["starting", "queued", "running"]),
};

/** Exits that leave work behind: the default view keeps only the recent ones. */
const BG_RUN_ABNORMAL_STATES: Record<BgRunKind, ReadonlySet<string>> = {
  bash: new Set(["failed", "stopped", "signal"]),
  subagent: new Set(["failed", "aborted", "interrupted"]),
};

/** The state that means the run got its answer out. */
const BG_RUN_COMPLETED_STATE: Record<BgRunKind, string> = { bash: "succeeded", subagent: "completed" };

/** How long a bad exit stays in the default process list. */
const BG_RUN_RECENT_EXIT_MS = 60 * 60 * 1000;

/** How long a description is in the list: enough to recognize the run, short enough to scan. */
const BG_RUN_DESCRIPTION_MAX = 120;

const BG_RUN_FILTERS = ["recent", "active", "unfinished", "completed", "all"] as const;

/** A row's description: one line, whitespace collapsed, capped short of a split code point. */
export function bgRunField(value: string, max = BG_RUN_DESCRIPTION_MAX): string {
  const flat = value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const last = flat.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${flat.slice(0, cut)}…`;
}

/** A subagent's description: which profile ran it, then what it was asked to do. */
export function subagentRunDescription(profile: string, description: string): string {
  const profileName = profile.trim();
  return profileName ? `${profileName}: ${description}` : description;
}

function isActive(entry: BgRunEntry): boolean {
  return BG_RUN_ACTIVE_STATES[entry.kind].has(entry.state);
}

function isAbnormalExit(entry: BgRunEntry): boolean {
  return BG_RUN_ABNORMAL_STATES[entry.kind].has(entry.state);
}

function isCompleted(entry: BgRunEntry): boolean {
  return entry.state === BG_RUN_COMPLETED_STATE[entry.kind];
}

function isUnfinished(entry: BgRunEntry): boolean {
  return isActive(entry) || isAbnormalExit(entry);
}

function isRecentExit(entry: BgRunEntry, now: number): boolean {
  const endedAt = Date.parse(entry.lastActivityAt);
  return Number.isFinite(endedAt) && now - endedAt <= BG_RUN_RECENT_EXIT_MS;
}

/**
 * The table: a fixed header plus one compact row per run, never a task or a result. The default
 * view is a process list — live runs plus exits recent enough to still matter — with what it left
 * out counted in one note instead of filling the answer.
 */
export function formatBgRunList(
  entries: readonly BgRunEntry[],
  options: { status?: string; now?: number } = {},
): string {
  const filter = BG_RUN_FILTERS.includes(options.status as (typeof BG_RUN_FILTERS)[number])
    ? (options.status as (typeof BG_RUN_FILTERS)[number])
    : "recent";
  const now = options.now ?? Date.now();
  const recent = (entry: BgRunEntry) => isRecentExit(entry, now);
  const filtered = entries.filter((entry) => {
    if (filter === "all") return true;
    if (filter === "active") return isActive(entry);
    if (filter === "completed") return isCompleted(entry);
    if (filter === "unfinished") return isUnfinished(entry);
    return isActive(entry) || (isAbnormalExit(entry) && recent(entry));
  });
  if (entries.length === 0) return "No background runs started by this session.";

  const olderExits = filter === "recent"
    ? entries.filter((entry) => isAbnormalExit(entry) && !recent(entry)).length
    : 0;
  const completedHidden = filter === "recent"
    ? entries.filter((entry) => isCompleted(entry)).length
    : 0;
  const hiddenNote = () => {
    const what = [
      ...(olderExits > 0 ? [`${olderExits} older exit${olderExits === 1 ? "" : "s"}`] : []),
      ...(completedHidden > 0 ? [`${completedHidden} completed run${completedHidden === 1 ? "" : "s"}`] : []),
    ];
    const ways = olderExits > 0 && completedHidden > 0
      ? '"all"'
      : olderExits > 0 ? '"unfinished" or "all"' : '"completed" or "all"';
    return `note: ${what.join(" and ")} not shown; set status to ${ways} to include them.`;
  };

  if (filtered.length === 0) {
    if (filter === "active") return "No background runs are running or queued.";
    if (filter === "completed") return "No completed background runs.";
    if (filter === "all") return "No background runs started by this session.";
    const empty = filter === "recent"
      ? "No background runs are active or recently exited."
      : "No active or unresolved background runs.";
    return olderExits + completedHidden > 0 ? `${empty}\n${hiddenNote()}` : empty;
  }

  const sorted = [...filtered].sort((a, b) => {
    const rank = Number(!isActive(a)) - Number(!isActive(b));
    return rank || b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
  const lines = [BG_RUN_HEADER];
  for (const entry of sorted) {
    lines.push([
      bgRunField(entry.id, 64),
      entry.kind,
      entry.state,
      bgRunField(entry.lastActivityAt, 40),
      bgRunField(entry.description),
    ].join("\t"));
  }
  if (olderExits + completedHidden > 0) lines.push(hiddenNote());
  return lines.join("\n");
}
