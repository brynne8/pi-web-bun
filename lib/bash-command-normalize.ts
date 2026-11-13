import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, AgentToolCall } from "@earendil-works/pi-agent-core";
import { stripWorkingDirectoryCd, type WorkingDirectoryCdOptions } from "./bash-command-cd";

export const BASH_COMMAND_NORMALIZE_EXTENSION_NAME = "pi-web-bash-command-normalize";

/** The tools that run their `command` in the session's directory. */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A copy of `message` with a leading `cd <cwd>` off every shell command it carries, or
 * `undefined` when it carries none. pi persists and executes the message a `message_end`
 * handler returns, so one rewrite reaches the session file, the tool that runs, the
 * history the model reads next turn, and the card.
 */
export function stripWorkingDirectoryCdInMessage(
  message: AgentMessage,
  cwd: string,
  options: WorkingDirectoryCdOptions = {},
): AgentMessage | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  let changed = false;
  const content = message.content.map((block) => {
    if (!isRecord(block) || block.type !== "toolCall") return block;
    const call = block as unknown as AgentToolCall;
    if (!SHELL_TOOL_NAMES.has(call.name) || typeof call.arguments?.command !== "string") return block;
    const stripped = stripWorkingDirectoryCd(call.arguments.command, cwd, options);
    if (!stripped.stripped) return block;
    changed = true;
    return { ...call, arguments: { ...call.arguments, command: stripped.command } };
  });
  return changed ? { ...message, content } as AgentMessage : undefined;
}

/**
 * Stands on its own extension rather than beside the bash tool it cleans: a user
 * extension that brings its own `bash` drops Pi Web's tool and keeps its own, while this
 * rule is about what the model wrote, not about which tool runs it.
 */
export function createBashCommandNormalizeExtension(options: {
  cwd: string;
  caseInsensitivePaths?: boolean;
}): InlineExtension {
  return {
    name: BASH_COMMAND_NORMALIZE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("message_end", (event) => {
        const message = stripWorkingDirectoryCdInMessage(event.message, options.cwd, {
          caseInsensitivePaths: options.caseInsensitivePaths,
        });
        return message ? { message } : undefined;
      });
    },
  };
}
