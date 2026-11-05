/**
 * The server's one answer to SIGINT and SIGTERM.
 * Signal handlers replace default termination; vinext keeps its socket open,
 * so cleanup must end in an explicit exit. See docs/agents/sessions.md.
 */
const SHUTDOWN_DEADLINE_MS = 5_000;

type ShutdownSignal = "SIGINT" | "SIGTERM";
export type ShutdownOutcome = Readonly<{
  signal: ShutdownSignal;
  phase: "started" | "completed" | "deadline";
  rejectedCleanups: number;
  graceful: boolean;
}>;
type Cleanup = (signal: ShutdownSignal) => void | Promise<void>;
type Observer = (outcome: ShutdownOutcome) => void | Promise<void>;
type ShutdownState = {
  cleanups: Set<Cleanup>;
  observers: Set<Observer>;
  installed: boolean;
  shuttingDown: boolean;
};

// Instrumentation and routes can load independent bundles in the same process.
const STATE_KEY = Symbol.for("pi-web:server-shutdown");
const globals = globalThis as typeof globalThis & { [STATE_KEY]?: ShutdownState };
const state = globals[STATE_KEY] ??= {
  cleanups: new Set<Cleanup>(),
  observers: new Set<Observer>(),
  installed: false,
  shuttingDown: false,
};

/** Observes shutdown progress synchronously, without delaying or interrupting exit. */
export function subscribeShutdownOutcome(observer: Observer): () => void {
  state.observers.add(observer);
  return () => { state.observers.delete(observer); };
}

function notify(outcome: ShutdownOutcome): void {
  for (const observer of state.observers) {
    try {
      void Promise.resolve(observer(Object.freeze({ ...outcome }))).catch(() => {});
    } catch {
      // Diagnostics must never prevent cleanup or exit.
    }
  }
}

/** Registers a cleanup, installing one pair of signal handlers across all bundles. */
export function onServerShutdown(cleanup: Cleanup): void {
  state.cleanups.add(cleanup);
  if (state.installed) return;
  state.installed = true;
  const shutdown = (signal: ShutdownSignal) => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    let rejectedCleanups = 0;
    let finished = false;
    const finish = (phase: "completed" | "deadline") => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      notify({ signal, phase, rejectedCleanups, graceful: phase === "completed" && rejectedCleanups === 0 });
      process.exit(0);
    };
    console.log(`[pi-web] shutdown requested (${signal}); running ${state.cleanups.size} cleanups`);
    // The server's handles, not this timer, must keep the loop alive.
    const deadline = setTimeout(() => {
      console.warn(`[pi-web] a shutdown cleanup is still running after ${SHUTDOWN_DEADLINE_MS}ms, exiting`);
      finish("deadline");
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref?.();
    notify({ signal, phase: "started", rejectedCleanups: 0, graceful: false });
    void Promise.allSettled([...state.cleanups].map((cleanup) =>
      Promise.resolve().then(() => cleanup(signal)).catch((error: unknown) => {
        rejectedCleanups += 1;
        throw error;
      }),
    )).then(() => finish("completed"));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
