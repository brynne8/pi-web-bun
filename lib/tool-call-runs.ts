/**
 * Adjacent tool calls, merged into one row.
 *
 * A run's steps repeat: five reads in a row, six shell commands in a row. Each
 * on its own line, a stretch of work reads as a list of near-identical rows,
 * and the eye has nothing to hold on to. One row that says `read ×5` says the
 * same thing in a fifth of the space, and the five are one click away.
 *
 * What bounds a run is the model's own words. A thought between two calls does
 * not appear at all — a thought that has been said and moved on from is not
 * shown, which is what lets a run's steps read as one thing. Measured over 54k
 * real calls, runs bounded by the model's words absorb seven eighths of them;
 * runs bounded by thoughts absorb a quarter.
 *
 * A group holds the whole stretch, written or not: a run being written groups as
 * it goes, so the screen shows one row however long it gets. What the current
 * step is, is one click away — and the group is collapsed by default, which is
 * what keeps a running turn from growing.
 *
 * A run's identity is its first member, never its last or its length: a run
 * that grows while it streams would otherwise remount and lose the reader's
 * place.
 */

import {
  isApplyPatchToolName,
  isEditToolName,
  isReadToolName,
  isShellToolName,
  isWriteToolName,
} from "./tool-names.ts";
import { CODEMODE_TOOL_NAME } from "./codemode-view.ts";

export type ToolFamily =
  | "execute"
  | "explore"
  | "changes"
  | "codemode"
  | "subagent"
  | "notify"
  | "other";

const SUBAGENT_TOOL_NAMES = new Set(["agent", "task", "subagent"]);
const SUBAGENT_PREFIXES = [
  "get_subagent",
  "steer_subagent",
  "await_result",
  "list_subagent",
  "abort_subagent",
];
/** Read-only searches, which answer "where is it" and read alike in a run. */
const SEARCH_TOOL_NAMES = new Set(["grep", "glob", "ls", "find", "head", "rg"]);

/** The family a tool call belongs to, for the purpose of merging neighbours. */
export function toolCallFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase();
  if (isShellToolName(name)) return "execute";
  if (isReadToolName(name) || SEARCH_TOOL_NAMES.has(name)) return "explore";
  if (isEditToolName(name) || isWriteToolName(name) || isApplyPatchToolName(name)) return "changes";
  if (name === CODEMODE_TOOL_NAME) return "codemode";
  if (SUBAGENT_TOOL_NAMES.has(name) || SUBAGENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "subagent";
  }
  if (name.includes("notification")) return "notify";
  return "other";
}

/** Families whose members read alike enough that a run of them says more merged. */
const MERGEABLE: ReadonlySet<ToolFamily> = new Set<ToolFamily>([
  "execute",
  "explore",
  "changes",
  "codemode",
  "subagent",
]);

export interface ToolRunItem<T> {
  kind: "single" | "run";
  /** Everything the run holds, in order. */
  items: T[];
  /** The tool calls the run holds, which is what its count says. One member may
   *  stand for several: a response that asks for parallel calls. */
  callCount: number;
  family: ToolFamily;
  /** The first member, which is what a run's identity is anchored to. */
  first: T;
}

/** What an item brings to a run: its family, and how many calls it stands for. */
export interface ToolRunMembership {
  family: ToolFamily | null;
  callCount: number;
}

/**
 * `items` in order, with a stretch's tool calls merged.
 *
 * `membershipOf` returns a null family for an item that cannot join a run — the
 * model's own words, a call whose input is still streaming — and such an item
 * both stands alone and ends the run on either side of it.
 */
export function groupAdjacentToolCalls<T>(
  items: readonly T[],
  membershipOf: (item: T) => ToolRunMembership,
  options: { minRunLength?: number } = {},
): ToolRunItem<T>[] {
  const minRunLength = options.minRunLength ?? 2;
  const groups: ToolRunItem<T>[] = [];
  let run: { item: T; calls: number }[] = [];
  let runFamily: ToolFamily | null = null;
  const callCount = (list: readonly { item: T; calls: number }[]) => list.reduce((total, member) => total + member.calls, 0);

  const emitSingles = (list: readonly { item: T; calls: number }[], family: ToolFamily) => {
    for (const member of list) {
      groups.push({ kind: "single", items: [member.item], callCount: member.calls, family, first: member.item });
    }
  };

  const closeRun = () => {
    if (run.length === 0) return;
    const family = runFamily ?? "other";
    const members = run;
    if (runFamily !== null && MERGEABLE.has(runFamily) && callCount(members) >= minRunLength) {
      groups.push({
        kind: "run",
        items: members.map((member) => member.item),
        callCount: callCount(members),
        family: runFamily,
        first: run[0]!.item,
      });
      if (members.length !== run.length) emitSingles(run.slice(members.length), family);
    } else {
      emitSingles(run, family);
    }
    run = [];
    runFamily = null;
  };

  for (const item of items) {
    const { family, callCount: calls } = membershipOf(item);
    if (family === null || !MERGEABLE.has(family)) {
      closeRun();
      groups.push({ kind: "single", items: [item], callCount: calls, family: family ?? "other", first: item });
      continue;
    }
    if (runFamily !== null && runFamily !== family) closeRun();
    if (runFamily === null) runFamily = family;
    run.push({ item, calls });
  }
  closeRun();
  return groups;
}
