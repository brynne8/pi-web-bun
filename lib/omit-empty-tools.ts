import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const OMIT_EMPTY_TOOLS_EXTENSION_NAME = "pi-web-omit-empty-tools";

interface RequestPayload {
  messages?: unknown;
  tools?: unknown;
}

/**
 * Drops a `tools` field that is an empty array: a chat-completions upstream reads the
 * field's presence rather than its length, so "no tools" is the field being absent — its
 * `tool_choice` default is `none` only when no tools are present — and a strict one
 * answers 400 `tools must not be an empty array`. pi-ai adds the empty array for one
 * proxy that wants it present; no other api it builds assembles one.
 */
export function omitEmptyTools(payload: unknown): unknown | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const request = payload as RequestPayload;
  if (!Array.isArray(request.messages) || !Array.isArray(request.tools) || request.tools.length > 0) {
    return undefined;
  }
  const withoutTools = { ...(payload as Record<string, unknown>) };
  delete withoutTools.tools;
  return withoutTools;
}

/**
 * Applies `omitEmptyTools()` to every provider request of the session. Registered so a
 * run that takes all its tools away — a subagent's wrap-up turn, a chat left on the
 * "No tools" preset — sends a request every chat-completions upstream accepts.
 */
export function createOmitEmptyToolsExtension(): InlineExtension {
  return {
    name: OMIT_EMPTY_TOOLS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_provider_request", (event) => omitEmptyTools(event.payload));
    },
  };
}
