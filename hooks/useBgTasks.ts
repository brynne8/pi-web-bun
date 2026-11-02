"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BgTaskListResponse, BgTaskSummary } from "@/lib/bg-task-types";
import { usePageHiddenFor } from "@/hooks/usePageHidden";

const POLL_MS = 2500;

/**
 * The server's live background bash tasks. Polled rather than streamed: one cheap list read,
 * paused once the page has been hidden past the usual grace period.
 */
export function useBgTasks() {
  const [tasks, setTasks] = useState<BgTaskSummary[]>([]);
  const [runningCount, setRunningCount] = useState(0);
  const hidden = usePageHiddenFor(30_000);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/bg-tasks", { cache: "no-store" });
      if (!response.ok) return;
      const body = await response.json() as BgTaskListResponse;
      setTasks(Array.isArray(body.tasks) ? body.tasks : []);
      setRunningCount(typeof body.runningCount === "number" ? body.runningCount : 0);
    } catch {
      // The next poll retries; a failed list read is not a page failure.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (hidden) return;
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [hidden, refresh]);

  return { tasks, runningCount, refresh };
}
