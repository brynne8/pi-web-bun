import { Type } from "typebox";
import { defineTool, type InlineExtension, type ToolExposure } from "@earendil-works/pi-coding-agent";
import { LIST_BG_RUNS_TOOL_NAME, formatBgRunList, subagentRunDescription, type BgRunEntry } from "./bg-runs.ts";
import { bgTaskHandle } from "./bg-task-handle.ts";
import { bgTaskState } from "./bg-task-status.ts";
import { filterBgTasksBySession } from "./bg-task-filter.ts";
import { listBgTasks } from "./bash-bg-tasks.ts";
import { shortSessionId } from "./session-short-id.ts";
import type { SubagentExtensionRuntime } from "./subagent-extension.ts";
import type { BgTaskSummary } from "./bg-task-types.ts";

/**
 * The one tool that lists a session's background work: commands it handed to the background and
 * subagents it delegated, in one table.
 *
 * It is an extension of its own for the reason `get_result` is: the two switches behind it are
 * independent, and hosted in the subagent extension it would vanish with built-in subagents, taking
 * the only listing of background commands with it. What it offers is decided per backend, and its
 * description says only what it can do.
 *
 * Listing is not fetching. The rows say which runs exist and how they are going; the output of one
 * comes only from `get_result`, and a report still on its way is not disturbed by a look.
 */

const LIST_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

export interface ListBgRunsOptions {
  /** The subagent runtime, when built-in subagents are on. */
  subagents?: SubagentExtensionRuntime;
  /**
   * Whether background bash is on, read per call so the answer follows the switch a person just
   * flipped rather than the one that was on when the session started.
   */
  bgTasks?: () => boolean;
}

export function createListBgRunsExtension(options: ListBgRunsOptions): InlineExtension {
  return {
    name: "pi-web-list-bg-runs",
    hidden: true,
    factory: (pi) => {
      const subagents = options.subagents;
      const bashOn = () => options.bgTasks?.() === true;
      if (!subagents && !bashOn()) return;

      const rows = subagents && bashOn()
        ? "A row is a background command (`bash`) or a subagent run (`subagent`)."
        : subagents
          ? "Every row is a subagent run."
          : "Every row is a background command.";
      const description = [
        `List this session's background runs as TSV: id, kind, state, last_activity, description. ${rows}`,
        "Read it when you no longer remember which runs exist; its `id` is what `get_result` fetches with.",
        "The default view is a process list: runs still going, plus runs that ended badly in the last hour, active ones first.",
        "Finished runs and older exits are counted in one note, which `status` asks for.",
      ].join(" ");

      pi.registerTool(defineTool({
        name: LIST_BG_RUNS_TOOL_NAME,
        label: "List background runs",
        description,
        exposure: LIST_TOOL_EXPOSURE,
        parameters: Type.Object({
          status: Type.Optional(Type.String({ description: 'Which runs to list: "recent" (default), "active", "unfinished", "completed", or "all".' })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          if (!sessionId) {
            return { content: [{ type: "text" as const, text: "Cannot list background runs: no session." }], details: undefined, isError: true };
          }
          try {
            const entries = [
              ...(bashOn() ? bashRunEntries(filterBgTasksBySession(listBgTasks(), sessionId)) : []),
              ...(subagents ? await subagentRunEntries(subagents, sessionId) : []),
            ];
            return {
              content: [{ type: "text" as const, text: formatBgRunList(entries, { status: params.status }) }],
              details: { kind: "pi-web-bg-runs", count: entries.length },
            };
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
          }
        },
      }));
    },
  };
}

/** The session's background commands, as rows. A finished one is listed while its log is kept. */
function bashRunEntries(tasks: readonly BgTaskSummary[]): BgRunEntry[] {
  return tasks.map((task) => ({
    kind: "bash" as const,
    // The handle, not the registry id: the row's id is what `get_result` takes.
    id: bgTaskHandle(task.logPath),
    state: bgTaskState(task),
    lastActivityAt: new Date(Math.max(task.lastOutputAtMs, task.startedAtMs)).toISOString(),
    description: task.command,
  }));
}

/** The subagents this session delegated, as rows, read from the session index and the live run map. */
async function subagentRunEntries(runtime: SubagentExtensionRuntime, parentSessionId: string): Promise<BgRunEntry[]> {
  const entries = await runtime.list(parentSessionId);
  return entries.map((entry) => ({
    kind: "subagent" as const,
    id: shortSessionId(entry.sessionId),
    state: entry.status,
    lastActivityAt: entry.updatedAt,
    description: subagentRunDescription(entry.profile, entry.description),
  }));
}
