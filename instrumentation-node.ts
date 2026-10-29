// First import on purpose. It patches `fs.promises.realpath` and registers an
// ESM loader hook, and a named builtin import only takes a patch that was
// already there when the module was evaluated, so this has to precede anything
// that may load `node:fs/promises` (including the pi SDK preimport at the
// bottom). `lib/dlp-realpath-compat.ts` holds the driver story and what its one
// start-up log line means.
import { reportRealpathCoverage } from "@/lib/dlp-realpath-compat";
import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { onServerShutdown } from "@/lib/server-shutdown";
import { pruneBgLogs } from "@/lib/bash-bg-tasks";
import { applyCodemodeWorkerDefault } from "@/lib/codemode-workers";

export function registerNodeInstrumentation(): void {
  // Before any session can run a codemode script (lib/codemode-workers.ts).
  applyCodemodeWorkerDefault();
  // Which of the shim's two ways in a consumer of `node:fs/promises` actually
  // got, on the first line of the server's log. The patch and the hook are both
  // already installed by the import above; this only reports them.
  reportRealpathCoverage();

  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // Closing the streams is what lets a shutdown finish at all: an SSE response
  // only ends when the client disconnects, so an open one would hold the process
  // open past the deadline. The exit itself belongs to `lib/server-shutdown.ts`,
  // which every shutdown path goes through.
  onServerShutdown(closeAllAgentEventStreams);

  // Background bash logs are swept from `bgLogPath()` too, but that only runs as a task
  // starts: with the `bgTasksEnabled` switch off, or on a machine that never runs one, a
  // day-old log sat there forever (337 of them, 158 MB, on one developer's machine).
  // Once per server instance, whoever the switch is set to. Never throws.
  pruneBgLogs();

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // the launcher opens the browser only once the first page is served, after
  // it (bin/browser-opener.js), and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}
