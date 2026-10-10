import type { AgentUsage, AssistantMessage } from "./types";

/**
 * The copies a turn's segments render from, kept per stored message.
 *
 * MessageView is memoized, and a copy built afresh on each render defeats it:
 * every visible part of a turn would run its markdown again whenever anything
 * in the chat changes — a streamed chunk, a notice, a key typed into an
 * extension's custom panel (#1005). So each `(message, block range)` copy is
 * built once and reused, which also keeps a part's React keys stable.
 */
export type TurnPartCache = WeakMap<AssistantMessage, Map<string, AssistantMessage>>;

/** A copy carrying `message`'s blocks `[start, end)`, stable across renders. */
export function getTurnPart(
  cache: TurnPartCache,
  message: AssistantMessage,
  start: number,
  end: number,
): AssistantMessage {
  const key = `${start}:${end}`;
  let byRange = cache.get(message);
  if (!byRange) {
    byRange = new Map();
    cache.set(message, byRange);
  }
  const cached = byRange.get(key);
  if (cached) return cached;

  const content = message.content ?? [];
  const next: AssistantMessage = { ...message, content: content.slice(start, end) };
  if (end < content.length) {
    // Not the end of this response: usage, the provider error and the output-limit
    // notice belong to where the response ended, so one part carries them.
    next.usage = undefined;
    next.stopReason = undefined;
    next.errorMessage = undefined;
  }
  byRange.set(key, next);
  return next;
}

/**
 * Whether a response's usage records anything. A request that never reported
 * numbers — an aborted run, a cache-warming call — still carries a usage object of
 * zeros, and a footer reading "0 in · 0 out · $0.00" says nothing about the turn.
 */
export function recordsUsage(usage: AgentUsage): boolean {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0
    || (usage.cost?.total ?? 0) > 0;
}
