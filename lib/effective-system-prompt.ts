import type { AgentSessionLike } from "./pi-types";

/**
 * The system prompt a plugin forced for the next run, or undefined when none
 * did. Asks the session's extension runner to evaluate the `before_agent_start`
 * handlers once, with the session's own prompt options, and yields the text a
 * run sends; neither the transcript nor `agent.state.systemPrompt` shows a
 * forced prompt. The handlers run outside a run; the caller caches the result.
 */
export async function computeForcedSystemPrompt(session: AgentSessionLike): Promise<string | undefined> {
  const runner = session.extensionRunner;
  if (!runner) return undefined;
  const emit = runner.emitBeforeAgentStart?.bind(runner);
  const options = runner.createCommandContext?.()?.getSystemPromptOptions?.();
  if (!emit || !options) return undefined;
  const result = await emit({ messageType: "user", prompt: "" }, options);
  return result.systemPromptOptions?.forceSystemPrompt;
}
