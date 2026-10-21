import type { AgentSessionLike } from "./pi-types";

/**
 * The system prompt a plugin forced for the next run, or undefined when none did.
 *
 * Pi sends the `systemPrompt` a `before_agent_start` handler returns as the provider's
 * leading system prompt for that run and keeps its own structured sections in the
 * transcript. Neither the transcript nor `agent.state.systemPrompt` therefore shows what
 * a plugin added: the panel would claim a prompt the model never saw. The session's
 * extension runner can evaluate the handlers once, with the session's own prompt
 * options, and yields the text a run sends.
 *
 * The handlers run outside a run here, so an extension that changes the tools or ends
 * the session sees them a second time. The caller caches the result.
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
