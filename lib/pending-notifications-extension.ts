import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type InlineExtension,
  type ToolExposure,
} from "@earendil-works/pi-coding-agent";
import {
  PENDING_TOOL_NAME,
  formatPendingNotifications,
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
      pi.registerTool(defineTool({
        name: PENDING_TOOL_NAME,
        label: "Pending background results",
        description:
          "List background results that finished but have not reached this conversation yet: backgrounded commands and background subagent runs. "
          + "Returns how many are waiting and one line per result with how it ended, when it finished, and the call that fetches the whole thing. "
          + "Takes no arguments.",
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
