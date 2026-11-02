/** Client-safe shape of one background bash task, shared by the route and the side panel. */
export interface BgTaskSummary {
  id: string;
  sessionId: string;
  command: string;
  logPath: string;
  startedAtMs: number;
  lastOutputAtMs: number;
  /** Null while the process is still running. */
  finishedAtMs: number | null;
  exitCode: number | null;
  error: string | null;
  trigger: "background" | "time" | "lines";
  killedByUser: boolean;
}

export interface BgTaskListResponse {
  tasks: BgTaskSummary[];
  runningCount: number;
}

/** A page of a task's log: bytes from `offset`, base64 so a multi-byte code point survives a poll. */
export interface BgTaskOutputResponse {
  id: string;
  offset: number;
  data: string;
  running: boolean;
  task: BgTaskSummary;
}
