import type { BgTaskSummary } from "./bg-task-types";

/** What a task row should say about a task, beyond its clocks. */
export type BgTaskState = "running" | "stopping" | "stopped" | "succeeded" | "failed" | "signal";

/**
 * The row's status, not just whether it is finished: a killed task is still running until its
 * process settles, and a finished one says whether the command actually succeeded.
 */
export function bgTaskState(task: BgTaskSummary): BgTaskState {
  if (task.finishedAtMs === null) return task.killedByUser ? "stopping" : "running";
  if (task.killedByUser) return "stopped";
  if (task.exitCode === 0) return "succeeded";
  if (task.exitCode === null) return "signal";
  return "failed";
}
