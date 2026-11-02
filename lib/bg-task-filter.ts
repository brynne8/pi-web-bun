import type { BgTaskSummary } from "./bg-task-types";

/**
 * The activity view's tasks: the current session's own, so a page shows the commands its own
 * agent handed to the background. Another session's work is not this page's business, and a page
 * with no session selected has no tasks at all.
 */
export function filterBgTasksBySession(
  tasks: readonly BgTaskSummary[],
  sessionId: string | null | undefined,
): BgTaskSummary[] {
  if (!sessionId) return [];
  return tasks.filter((task) => task.sessionId === sessionId);
}
