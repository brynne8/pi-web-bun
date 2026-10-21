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
} from "./pending-notifications";

export const PENDING_NOTIFICATIONS_EXTENSION_NAME = "pi-web-pending-notifications";

/**
 * Read-only and argument-free, so it is safe to offer anywhere a run can be waiting on. It is
 * declared `model-only` like the subagent control tools: a codemode script has no business
 * deciding when the parent learns that a background result exists.
 */
const PENDING_TOOL_EXPOSURE = "model-only" satisfies ToolExposure;

/**
 * The index of background results that finished before the conversation had room for them.
 *
 * Registered on its own, not inside the subagent extension: background commands and subagent runs
 * have separate switches, and with the built-in subagents switched off the subagent extension
 * registers nothing at all — which would take the index for background commands down with it.
 */
export function createPendingNotificationsExtension(): InlineExtension {
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
      // it says how many there are and names the tool, and says nothing about what to do next.
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
          "List background results that finished but have not reached this conversation: backgrounded commands and background subagent runs. "
          + "Returns the count and one line per result: outcome, finish time, and the call that fetches it.",
        exposure: PENDING_TOOL_EXPOSURE,
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          if (!sessionId) return { content: [{ type: "text", text: "No session to read." }], details: undefined };
          const entries = ctx.sessionManager.getEntries?.() ?? [];
          const pending = pendingNotificationsFor(sessionId, entries as readonly unknown[]);
          return {
            content: [{ type: "text", text: formatPendingNotifications(pending) }],
            details: { kind: "pi-web-pending", count: pending.length },
          };
        },
      }));
    },
  };
}
