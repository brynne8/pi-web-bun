import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type InlineExtension,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import {
  PENDING_POINTER_CUSTOM_TYPE,
  PENDING_TOOL_NAME,
  formatPendingNotifications,
  formatPendingPointer,
  pendingNotificationsFor,
  type PendingNotification,
} from "./pending-notifications";

export const PENDING_NOTIFICATIONS_EXTENSION_NAME = "pi-web-pending-notifications";

export interface PendingNotificationsOptions {
  /**
   * Whether this session still has background work that can settle: a command or a subagent run.
   * The tool waits only while this is true. Without it there is nothing to wait for, so a call
   * answers at once — the tool must never hold a run open on a result nothing will produce.
   */
  hasLiveBackgroundWork?: (sessionId: string) => boolean;
}

/**
 * Read-only and argument-free, so it is safe to offer anywhere a run can be waiting on. It is
 * declared `model-only` like the subagent control tools: a codemode script has no business
 * deciding when the parent learns that a background result exists.
 */
const PENDING_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

/** How often the wait re-reads the index; the same interval `get_subagent_result`'s wait uses. */
const PENDING_WAIT_POLL_MS = 500;

/**
 * The index of background results that finished before the conversation had room for them.
 *
 * Registered on its own, not inside the subagent extension: background commands and subagent runs
 * have separate switches, and with the built-in subagents switched off the subagent extension
 * registers nothing at all — which would take the index for background commands down with it.
 */
export function createPendingNotificationsExtension(options: PendingNotificationsOptions = {}): InlineExtension {
  const hasLiveBackgroundWork = options.hasLiveBackgroundWork;

  return {
    name: PENDING_NOTIFICATIONS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Message ids a reminder already covered: one reminder per batch, so a later batch is
      // reminded again and one that reached the conversation is not reminded at all.
      const announced = new Set<string>();
      // The reminder. A report waits for the run to end, which is the whole run — a model ten
      // tool calls into a refactor learns about a finished build only when it stops. So at
      // every turn boundary, while results are still waiting, one model-only line is steered:
      // it says how many there are, names the tool, and says this reminder is when to call it.
      pi.on("turn_end", (_event, ctx) => {
        const sessionId = ctx?.sessionManager?.getSessionId?.();
        if (!sessionId) return;
        const entries = ctx.sessionManager.getEntries?.() ?? [];
        const waiting = pendingNotificationsFor(sessionId, entries as readonly unknown[])
          .filter((entry) => !announced.has(entry.messageId));
        if (waiting.length === 0) return;
        for (const entry of waiting) announced.add(entry.messageId);
        // Steered rather than queued, so it lands before the next response instead of at the end
        // of the run; `display: false` because pi's `convertToLlm` replays a custom message
        // whatever `display` says, while the chat skips it — the model always reads it and no
        // card appears.
        pi.sendMessage({
          customType: PENDING_POINTER_CUSTOM_TYPE,
          display: false,
          content: formatPendingPointer(waiting),
          // No `notificationId` here: the index clears on a report's own message, and a reminder
          // must never be mistaken for one.
          details: { kind: "pi-web-pending-pointer", messageIds: waiting.map((entry) => entry.messageId) },
        }, { deliverAs: "steer" });
      });

      pi.registerTool(defineTool({
        name: PENDING_TOOL_NAME,
        label: "Pending background results",
        description:
          "Read background results a reminder has just announced: commands and subagent runs that finished but have not reached this conversation. "
          + "With nothing waiting, this waits while background work is still running and returns as soon as a result settles; with nothing running it answers at once. "
          + "Returns the count and one line per result: outcome, finish time, and the call that fetches it.",
        exposure: PENDING_TOOL_EXPOSURE,
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          if (!sessionId) return { content: [{ type: "text", text: "No session to read." }], details: undefined };
          const pending = await waitForPending(sessionId, ctx, signal, hasLiveBackgroundWork);
          return {
            content: [{ type: "text", text: formatPendingNotifications(pending) }],
            details: { kind: "pi-web-pending", count: pending.length },
          };
        },
      }));
    },
  };
}

/**
 * The index now, or the first index that is not empty while background work is still running.
 *
 * A report waits for its run to end, which is the whole run, so a model that wants a finished
 * result mid-run has no way to yield to it. Waiting here is that yield: the call holds until a
 * report settles, and the model reads it instead of polling a reminder. The wait ends when
 * nothing is left that could produce a result, so an idle session never hangs on this tool.
 */
async function waitForPending(
  sessionId: string,
  ctx: { sessionManager?: { getEntries?: () => unknown } } | undefined,
  signal: AbortSignal | undefined,
  hasLiveBackgroundWork: PendingNotificationsOptions["hasLiveBackgroundWork"],
): Promise<PendingNotification[]> {
  const read = () => pendingNotificationsFor(sessionId, (ctx?.sessionManager?.getEntries?.() ?? []) as readonly unknown[]);
  const pending = read();
  if (pending.length > 0 || !hasLiveBackgroundWork?.(sessionId)) return pending;
  while (true) {
    await pollDelay(signal);
    const settled = read();
    if (settled.length > 0) return settled;
    if (hasLiveBackgroundWork(sessionId)) continue;
    // A run leaves its live registry the moment it settles, before its report reaches the index:
    // one more poll catches a report being written right now instead of answering "nothing".
    await pollDelay(signal);
    return read();
  }
}

/** One poll interval, ended early when the run is stopped. */
function pollDelay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Pending results wait aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, PENDING_WAIT_POLL_MS);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}
