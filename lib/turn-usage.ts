import type { AgentMessage, AgentUsage } from "./types";
import { recordsUsage } from "./turn-views";

function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * What the turn's own model requests cost, summed, or undefined when the turn
 * billed nothing. The tool loop makes a request per call and pi stores each as its
 * own assistant entry, so the turn's total is every one of them. The token buckets
 * are summed apart as the footer prints them: `input` and the two cache counts are
 * separate figures whose sum is the prompt, so `input` never counts a cache read.
 */
export function getTurnUsage(messages: AgentMessage[], anchorIdx: number, endIdx: number): AgentUsage | undefined {
  let total: AgentUsage | undefined;
  for (let idx = anchorIdx + 1; idx < endIdx; idx++) {
    const message = messages[idx];
    // A tool result's usage belongs to a nested call, not to one of the turn's requests.
    if (message.role !== "assistant") continue;
    const usage = message.usage;
    if (!usage) continue;
    if (!total) total = emptyUsage();
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.cost.input += usage.cost?.input ?? 0;
    total.cost.output += usage.cost?.output ?? 0;
    total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
    total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
    total.cost.total += usage.cost?.total ?? 0;
  }
  return total && recordsUsage(total) ? total : undefined;
}
