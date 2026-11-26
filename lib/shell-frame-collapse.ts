import type { InlineExtension, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { collapseTerminalOverwrites } from "./ansi-overwrite.ts";
import { isShellToolName } from "./tool-names.ts";

export const SHELL_FRAME_COLLAPSE_EXTENSION_NAME = "pi-web-shell-frame-collapse";

/**
 * A command that animates repaints one row instead of writing new ones, and captured output
 * keeps every frame it drew: 71 copies of one spinner line from one install. The screen it
 * ended on is what the model reads here, and what the card has to draw.
 */
export function collapseShellResultFrames(event: ToolResultEvent): ToolResultEventResult | undefined {
  if (!isShellToolName(event.toolName)) return undefined;
  let changed = false;
  const content = event.content.map((block) => {
    if (block.type !== "text") return block;
    const text = collapseTerminalOverwrites(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  if (!changed) return undefined;
  // Replacing content without it drops the structured content, which a shell tool has no
  // reason to declare but a user extension's `bash` may.
  return event.structuredContent === undefined
    ? { content }
    : { content, structuredContent: event.structuredContent };
}

/**
 * Its own extension rather than a pass inside Pi Web's `bash`: a child session runs pi's own
 * `bash`, and a user extension's `bash` replaces this fork's, while the frames are in the
 * output either way.
 */
export function createShellFrameCollapseExtension(): InlineExtension {
  return {
    name: SHELL_FRAME_COLLAPSE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("tool_result", (event) => collapseShellResultFrames(event));
    },
  };
}
