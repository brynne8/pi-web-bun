// Client-safe display of session usage: the toolbar's stats button and
// popover, and the agent switcher's per-agent rows.

import type { TranslationParams } from "./i18n/types.ts";
import type { Locale } from "./i18n/types.ts";
import { formatDuration } from "./i18n/format.ts";

/** 950 · 18k · 1.2M */
export function formatCompactCount(value: number): string {
  // 999_500 rounds to 1000k, which reads as 1.0M.
  if (value >= 999_500) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

/** $0.12 · <$0.01 · null when nothing was billed. */
export function formatCostShort(cost: number): string | null {
  if (!(cost > 0)) return null;
  return cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01";
}

/** "4 messages · 18k tokens · $0.12": the one line `/session` answers with in a tab, which has no popover. */
export function formatSessionSummary(stats: { totalMessages: number; tokens: { total: number }; cost: number } | null, t: (key: string, params?: TranslationParams) => string): string {
  if (!stats) return t("session.noUsage");
  const cost = formatCostShort(stats.cost);
  const summary = t(stats.totalMessages === 1 ? "session.usageSummaryOne" : "session.usageSummary", { messages: stats.totalMessages, tokens: formatCompactCount(stats.tokens.total) });
  return [summary, ...(cost ? [cost] : [])].join(" · ");
}

/** 0s · 42s · 3m 5s · 1h 5m 3s */
export function formatActiveDuration(ms: number, locale: Locale): string {
  return formatDuration(ms, locale);
}
