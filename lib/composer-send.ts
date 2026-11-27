// What the composer does with a submission: the send button, and the steer / follow-up
// keys. Both decide the same things — whether a `/command` takes the message, whether a
// `!` command runs beside the run, and whether a run is streaming — so they live here
// together, away from the component's JSX.

import type { SessionReferenceTarget } from "./session-reference-target.ts";
import { withSessionReferences } from "./session-reference-target.ts";

export interface ComposerSendDeps<Image = unknown> {
  value: string;
  attachedImages: Image[];
  isStreaming: boolean;
  /** The sessions quoted with `#`, which the message carries as tokens (lib/session-reference.ts). */
  attachedReferences?: readonly SessionReferenceTarget[];
  /** Whether the session can run a `/command` at all right now. */
  onBuiltinCommand?: unknown;
  onAudioUnlock?: () => void;
  onSend?: (message: string, images?: Image[]) => void;
  clearInput: () => void;
  runBuiltinCommand: (message: string) => Promise<boolean>;
  offersBuiltinSlashCommandWhileStreaming: (message: string) => boolean;
  /** The send button's own path, which a `!` command queued from steer uses. */
  handleSend?: () => void;
  canRunBuiltinSlashCommandWhileStreaming?: (message: string) => boolean;
  isBareMcpCommand?: (message: string) => boolean;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: Image[]) => void;
  onSteer?: (message: string, images?: Image[]) => void;
  onFollowUp?: (message: string, images?: Image[]) => void;
}

/** The text that goes out: the composer's own, with the quoted sessions' tokens behind it. */
function submittedText<Image>(deps: ComposerSendDeps<Image>): string {
  const msg = deps.value.trim();
  return withSessionReferences(msg, deps.attachedReferences ?? []);
}

/** The send button: a `/command` the composer owns takes the message, a `!` command runs beside the run, anything else queues. */
export async function handleComposerSend<Image>(deps: ComposerSendDeps<Image>): Promise<void> {
  const msg = deps.value.trim();
  if (!msg && !deps.attachedImages.length && !deps.attachedReferences?.length) return;
  deps.onAudioUnlock?.();
  const builtinAllowed = !deps.isStreaming || deps.offersBuiltinSlashCommandWhileStreaming(msg);
  if (builtinAllowed && await deps.runBuiltinCommand(msg)) return;
  // A `!` command runs beside the run, as in pi's TUI; anything else queues.
  if (deps.isStreaming && !(msg.startsWith("!") && !deps.attachedImages.length)) return;
  deps.clearInput();
  deps.onSend?.(submittedText(deps), deps.attachedImages.length ? deps.attachedImages : undefined);
}

/** Steer or follow-up: a `/command` the composer owns runs first, another one queues with its behavior named. */
export function handleComposerSendQueued<Image>(
  mode: "steer" | "followup",
  deps: ComposerSendDeps<Image>,
): void {
  const text = deps.value.trim();
  // A steer or follow-up carries the quoted sessions too: clearInput() drops them.
  const msg = withSessionReferences(text, deps.attachedReferences ?? []);
  if (!msg && !deps.attachedImages.length) return;
  if (text.startsWith("!") && !deps.attachedImages.length) {
    // A shell command is never steered into the run as text.
    void deps.handleSend?.();
    return;
  }
  deps.onAudioUnlock?.();
  const images: Image[] | undefined = deps.attachedImages.length ? deps.attachedImages : undefined;
  const queue = () => {
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/") && deps.onPromptWithStreamingBehavior) {
      deps.clearInput();
      deps.onPromptWithStreamingBehavior(msg, streamingBehavior, images);
      return;
    }
    deps.clearInput();
    if (mode === "steer" && deps.onSteer) {
      deps.onSteer(msg, images);
    } else if (mode === "followup" && deps.onFollowUp) {
      deps.onFollowUp(msg, images);
    }
  };
  if (!deps.attachedImages.length && deps.onBuiltinCommand && deps.canRunBuiltinSlashCommandWhileStreaming?.(msg)) {
    void deps.runBuiltinCommand(msg);
    return;
  }
  if (!deps.attachedImages.length && deps.onBuiltinCommand && deps.isBareMcpCommand?.(msg)) {
    // Settings › MCP opens when pi's built-in MCP extension owns /mcp; another
    // extension's /mcp is queued as before. The composer is disabled meanwhile.
    void deps.runBuiltinCommand(msg).then((handled) => {
      if (!handled) queue();
    }, () => queue());
    return;
  }
  queue();
}
