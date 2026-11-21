/**
 * The one tool that fetches a background result: a background command's log or a subagent's
 * report. Its name lives here because three places spell the hint a model copies: a background
 * command's report, the note a stop leaves, and the pending index `await_results` answers. Never
 * the start text: a model handed a handle before the result is ready fetches it early, and a
 * fetched result is withdrawn from delivery.
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
