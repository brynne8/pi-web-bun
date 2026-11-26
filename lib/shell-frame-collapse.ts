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

/** A command that writes one endless line would otherwise grow the buffer without bound. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface ShellStreamCollapse {
  /** Raw bytes as the child process produced them. */
  push(data: Buffer | string): void;
  /** The last line, however it ends. Further pushes are dropped, as they were before. */
  flush(): void;
}

/**
 * What the shell tool's `onData` becomes upstream: pi builds the tool result, the live output
 * and a `!` command's transcript entry out of these bytes, and none of them is a `tool_result`
 * the extension can reach. A row goes out when its line end arrives, so the frames a command
 * painted on it are behind us — the cost is that a row the command never ends shows nothing
 * until it exits. Bytes are cut at a line end and only there, never inside a character.
 */
export function createShellStreamCollapse(emit: (data: Buffer) => void): ShellStreamCollapse {
  let pending: Buffer | undefined;
  let closed = false;
  const emitText = (bytes: Buffer): void => {
    const text = collapseTerminalOverwrites(bytes.toString("utf8"));
    if (text !== "") emit(Buffer.from(text, "utf8"));
  };
  return {
    push(data) {
      if (closed) return;
      const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      const bytes = pending ? Buffer.concat([pending, chunk]) : chunk;
      const lineEnd = bytes.lastIndexOf(0x0a);
      if (lineEnd >= 0) {
        pending = lineEnd + 1 < bytes.length ? Buffer.from(bytes.subarray(lineEnd + 1)) : undefined;
        emitText(bytes.subarray(0, lineEnd + 1));
        return;
      }
      if (bytes.length > MAX_PENDING_BYTES) {
        pending = undefined;
        emitText(bytes);
        return;
      }
      pending = bytes;
    },
    flush() {
      if (closed) return;
      closed = true;
      const bytes = pending;
      pending = undefined;
      if (bytes) emitText(bytes);
    },
  };
}
