/**
 * The server's one answer to SIGINT and SIGTERM.
 *
 * A signal listener replaces the runtime's default terminate, and vinext's
 * production server never closes its listening socket, so the event loop never
 * drains on its own: a shutdown has to exit explicitly. docs/agents/sessions.md
 * holds the measurements, and what the alternatives that do not exit cost.
 */

/** How long a shutdown may take before the process exits anyway. */
const SHUTDOWN_DEADLINE_MS = 5_000;

const cleanups = new Set<() => void | Promise<void>>();
let installed = false;

/** Registers a cleanup for the next shutdown signal, installing the handlers on first use. */
export function onServerShutdown(cleanup: () => void | Promise<void>): void {
  cleanups.add(cleanup);
  if (installed) return;
  installed = true;
  let shuttingDown = false;
  const shutdown = () => {
    // A second signal must not start the cleanups over; what is still running is
    // the same work the first one asked for.
    if (shuttingDown) return;
    shuttingDown = true;
    // Unref'd: the server's own handles hold the process open, not this timer,
    // and a loop that drains on its own has to be allowed to.
    const deadline = setTimeout(() => {
      console.warn(`[pi-web] a shutdown cleanup is still running after ${SHUTDOWN_DEADLINE_MS}ms, exiting`);
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref?.();
    void Promise.allSettled([...cleanups].map((cleanup) => Promise.resolve().then(cleanup))).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
