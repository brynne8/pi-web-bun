import { Type } from "typebox";
import { defineTool, type InlineExtension, type ToolExposure } from "@earendil-works/pi-coding-agent";
import { readBgTaskLogSlice, resolveBgTaskLogPath } from "./bg-task-log.ts";
import { parseBgTaskHandle } from "./bg-task-handle.ts";
import { listBgTasks, recordBgTaskResultConsumed } from "./bash-bg-tasks.ts";
import { GET_RESULT_TOOL_NAME } from "./get-result-tool.ts";
import { lookupSubagentResult, waitTimeoutParameter, type SubagentExtensionRuntime } from "./subagent-extension.ts";
import type { PendingNotificationKind } from "./pending-notifications.ts";

/**
 * The one tool that fetches a finished background result: a background command's log, or a
 * subagent's report.
 *
 * It lives in an extension of its own because the two switches behind it are independent. Inside
 * the subagent extension it would disappear with that switch, taking a background command's only
 * way to fetch its output with it — a log's path never reaches the model. What the extension
 * offers is decided per backend at session start, and its description says only what it can do.
 *
 * Fetching is reading: the report the parent has not seen yet is withdrawn from its queue and the
 * pending index, so a result is paid for once.
 */

const RESULT_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

export interface GetResultOptions {
  /**
   * The pending-report sink, so a collected background command's report is taken back out of the
   * parent's queue. Absent when the parent has no sink to withdraw from.
   */
  withdraw(sessionId: string, kind: PendingNotificationKind, id: string): void;
  /** The subagent runtime, when built-in subagents are on. */
  subagents?: SubagentExtensionRuntime;
  /**
   * Whether background bash is on, read per call so the answer follows the switch a person just
   * flipped rather than the one that was on when the session started.
   */
  bgTasks?: () => boolean;
}

export function createGetResultExtension(options: GetResultOptions): InlineExtension {
  return {
    name: "pi-web-get-result",
    hidden: true,
    factory: (pi) => {
      const subagents = options.subagents;
      const bashOn = () => options.bgTasks?.() === true;
      if (!subagents && !bashOn()) return;

      const description = [
        subagents && bashOn()
          ? "Fetch a finished background result: a background command's output, or a subagent's report."
          : subagents
            ? "Fetch a subagent's report that is no longer in the conversation, or when the user asks for it."
            : "Fetch a finished background command's output, or when the user asks for it.",
        "Fetching counts as reading: the report you have not seen yet is withdrawn, so it will not arrive again.",
        ...(bashOn() ? ["A background command's output reads like a file — the first lines by default, then `offset` and `limit` for the rest, and the head says where you are."] : []),
        subagents
          ? "Never call this to check or wait for a run; its report arrives on its own."
          : "Never call this on a command that is still running; its report arrives on its own.",
      ].join(" ");

      pi.registerTool(defineTool({
        name: GET_RESULT_TOOL_NAME,
        label: "Get result",
        description,
        exposure: RESULT_TOOL_EXPOSURE,
        parameters: Type.Object({
          id: Type.String({
            description: [
              "The id the result shows, copied exactly:",
              ...(bashOn() ? ["`bash-3f2a9b1c` for a background command;"] : []),
              ...(subagents ? ["a subagent's 8-character id (its full session id also works)."] : []),
            ].join(" "),
          }),
          ...(bashOn()
            ? {
                offset: Type.Optional(Type.Integer({ minimum: 1, description: "First line of a background command's output (1-based). Default: 1." })),
                limit: Type.Optional(Type.Integer({ minimum: 1, description: "How many lines of a background command's output. Default: 2000." })),
              }
            : {}),
          ...(subagents
            ? {
                wait: Type.Optional(Type.Boolean({ description: "Only when the user asks you to wait for a run." })),
                wait_timeout: waitTimeoutParameter(),
              }
            : {}),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
          const input = params as { id: string; offset?: number; limit?: number; wait?: boolean; wait_timeout?: number };
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          if (parseBgTaskHandle(input.id)) {
            if (!bashOn()) {
              return {
                content: [{ type: "text" as const, text: "Background bash is switched off in this session, so its results cannot be fetched. The switch is read when a session starts; start a new session with it on." }],
                details: undefined,
                isError: true,
              };
            }
            return readBgTaskResult(sessionId, input, options.withdraw);
          }
          if (!subagents) {
            return {
              content: [{ type: "text" as const, text: `Built-in subagents are switched off in this session, so ${input.id} cannot be fetched. The switch is read when a session starts; start a new session with it on.` }],
              details: undefined,
              isError: true,
            };
          }
          const answer = await lookupSubagentResult(subagents, {
            id: input.id,
            wait: input.wait,
            waitTimeoutSeconds: input.wait_timeout,
            signal,
            sessionManager: ctx?.sessionManager,
          });
          return {
            content: [{ type: "text" as const, text: answer.text }],
            details: answer.details,
            ...(answer.isError ? { isError: true } : {}),
          };
        },
      }));
    },
  };
}

/**
 * One background command's output, as a page of its log. A handle's log is resolved from the
 * session's own log directory, so a result stays readable after the task has left the activity
 * view and across a server restart, until the sweep takes the file.
 */
async function readBgTaskResult(
  sessionId: string | undefined,
  input: { id: string; offset?: number; limit?: number },
  withdraw: GetResultOptions["withdraw"],
) {
  const handle = parseBgTaskHandle(input.id)!;
  const path = await resolveBgTaskLogPath(sessionId, input.id);
  if (!path) {
    return {
      content: [{ type: "text" as const, text: `No background command output for ${input.id}; its log is gone (one is kept a day past its last write).` }],
      details: undefined,
      isError: true,
    };
  }
  const running = listBgTasks().some((task) => task.logPath === path && task.finishedAtMs === null);
  if (running) {
    return {
      content: [{ type: "text" as const, text: `Background command ${input.id} is still running. Its result arrives on its own when it finishes; do not poll it.` }],
      details: undefined,
    };
  }
  const slice = await readBgTaskLogSlice(path, { offset: input.offset, limit: input.limit });
  if (!slice) {
    return { content: [{ type: "text" as const, text: `The log of ${input.id} could not be read.` }], details: undefined, isError: true };
  }
  // The parent holds this result now: the report still queued for it would repeat what it read.
  recordBgTaskResultConsumed(`bash-${handle}`);
  if (sessionId) withdraw(sessionId, "bash", `bash-${handle}`);
  const header = [`Background command ${input.id}: ${describeSlice(slice)}.`];
  // A log with more lines left, whether the cap was lines or bytes, says how to go on.
  const nextLine = slice.lastLine + 1;
  if (nextLine <= slice.totalLines) header.push(`Read on with offset: ${nextLine}.`);
  else if (slice.firstLine > 1) header.push(`Lines above ${slice.firstLine} were the start of this read; drop \`offset\` to read the log from its first line.`);
  return {
    content: [{ type: "text" as const, text: `${header.join(" ")}\n\n${slice.text}` }],
    details: undefined,
  };
}

/** Where a page sits in its log, in the words the header uses. */
function describeSlice(slice: { firstLine: number; lastLine: number; totalLines: number }): string {
  if (slice.totalLines === 0) return "the log is empty";
  if (slice.lastLine < slice.firstLine) return `the log has ${slice.totalLines} lines, and this read starts past the last of them`;
  return `lines ${slice.firstLine}-${slice.lastLine} of ${slice.totalLines}`;
}
