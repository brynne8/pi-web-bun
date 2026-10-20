// First import on purpose. It patches `fs.promises.realpath`, and a named
// builtin import only takes a patch that was already there when the module was
// evaluated, so this has to precede anything that may load `node:fs/promises`
// (including the pi SDK preimport at the bottom). `lib/dlp-realpath-compat.ts`
// holds the driver story and what its one start-up log line means.
import "@/lib/dlp-realpath-compat";
import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { pruneBgLogs } from "@/lib/bash-bg-tasks";

export function registerNodeInstrumentation(): void {
  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // Background bash logs are swept from `bgLogPath()` too, but that only runs as a task
  // starts: with the `bgTasksEnabled` switch off, or on a machine that never runs one, a
  // day-old log sat there forever (337 of them, 158 MB, on one developer's machine).
  // Once per server instance, whoever the switch is set to. Never throws.
  pruneBgLogs();

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // it overlaps the browser opening, and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}
