/**
 * The one tool that fetches a background result: a background command's log or a subagent's
 * report. Its name lives here because four places spell the hint a model copies: the background
 * command's start text, its report, a subagent's report, and the pending index.
 */
export const GET_RESULT_TOOL_NAME = "get_result";

/** The hint a background command's report and pending entry carry instead of its log path. */
export function bgTaskFetchHint(handle: string): string {
  return `${GET_RESULT_TOOL_NAME}("${handle}")`;
}

/** The hint a subagent's report and pending entry carry. */
export function subagentFetchHint(shortSessionId: string): string {
  return `${GET_RESULT_TOOL_NAME}("${shortSessionId}")`;
}
