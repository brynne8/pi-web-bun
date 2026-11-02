"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { countRunningSubagents, sideChatTitle } from "@/lib/session-family";
import type { SessionUsageSummary } from "@/lib/session-stats";
import { formatActiveDuration, formatCompactCount, formatCostShort } from "@/lib/session-stats-format";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";

/** The family the Agents section lists, as the sidebar's catalog and running poll know them. */
export interface ActivityAgentsProps {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
  /** Subagents with a viewer tab in the open right panel. */
  openSubagentTabIds: ReadonlySet<string>;
  /** Opens a subagent's read-only viewer tab in the right panel (the `Agent` card's button), or closes it when open. */
  onToggleSubagentTab: (sessionId: string, label: string, side?: boolean) => void;
  /** Forks the main agent into a side chat and opens its tab; answers the refusal to show, or null. */
  onNewSideChat: () => Promise<string | null>;
}

const STATS_POLL_MS = 3000;

/**
 * Usage of every agent in the family, as the toolbar's stats popover counts
 * it. Read on open and whenever a run starts or ends; polled while one runs,
 * on a visible page, one request at a time.
 */
function useAgentUsage(ids: readonly string[], runningKey: string): Record<string, SessionUsageSummary> {
  const [usage, setUsage] = useState<Record<string, SessionUsageSummary>>({});
  const idsKey = ids.join(",");
  useEffect(() => {
    const requested = idsKey ? idsKey.split(",") : [];
    if (requested.length === 0) return;
    const controller = new AbortController();
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/sessions/stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: requested }),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json() as { stats?: Record<string, SessionUsageSummary> };
        if (!controller.signal.aborted && data.stats) setUsage(data.stats);
      } catch {
        /* best-effort: rows keep their last numbers */
      } finally {
        inFlight = false;
      }
    };
    void load();
    if (!runningKey) return () => controller.abort();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, STATS_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [idsKey, runningKey]);
  return usage;
}

function usageTooltip(usage: SessionUsageSummary, t: (key: string) => string, locale: string): string {
  const { tokens } = usage;
  return [
    `${t("session.totalActive")}: ${formatActiveDuration(usage.totalActiveMs)}`,
    `${t("session.input")}: ${tokens.input.toLocaleString(locale)}`,
    `${t("session.output")}: ${tokens.output.toLocaleString(locale)}`,
    ...(tokens.cacheRead > 0 ? [`${t("session.cacheRead")}: ${tokens.cacheRead.toLocaleString(locale)}`] : []),
    ...(tokens.cacheWrite > 0 ? [`${t("session.cacheWrite")}: ${tokens.cacheWrite.toLocaleString(locale)}`] : []),
    `${t("session.total")}: ${tokens.total.toLocaleString(locale)}`,
    ...(usage.cost > 0 ? [`${t("session.cost")}: $${usage.cost.toFixed(4)}`] : []),
    `${t("session.toolCalls")}: ${usage.toolCalls.toLocaleString(locale)}`,
  ].join("\n");
}

function UsageLine({ usage, style }: { usage: SessionUsageSummary; style?: React.CSSProperties }) {
  const { locale, t } = useI18n();
  const cost = formatCostShort(usage.cost);
  return (
    <span
      title={usageTooltip(usage, t, locale)}
      style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", ...style }}
    >
      {usage.totalActiveMs > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          {formatActiveDuration(usage.totalActiveMs)}
        </span>
      )}
      {usage.tokens.total > 0 && (
        <span>{t("agentSwitcher.tokens", { count: formatCompactCount(usage.tokens.total) })}</span>
      )}
      {cost && <span style={{ color: "var(--text-muted)" }}>{cost}</span>}
    </span>
  );
}

function hasUsage(usage: SessionUsageSummary | undefined): usage is SessionUsageSummary {
  return Boolean(usage && (usage.tokens.total > 0 || usage.totalActiveMs > 0));
}

function sessionTitle(session: SessionInfo): string {
  return session.name || session.firstMessage || session.id.slice(0, 12);
}

function formatRelativeTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(elapsedSeconds) < 60) return formatter.format(elapsedSeconds, "second");
  const elapsedMinutes = Math.round(elapsedSeconds / 60);
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, "minute");
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, "hour");
  return formatter.format(Math.round(elapsedHours / 24), "day");
}

/** The run's state as a mark. A `label` makes it an image saying which state; alone it is decor. */
export function StatusIcon({ status, label }: { status: SubagentSessionStatus; label?: string }) {
  const named = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  const marks: Record<string, React.ReactNode> = {
    running: <><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
    failed: <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
    stopped: <><circle cx="12" cy="12" r="9" /><path d="M9 9h6v6H9z" /></>,
    completed: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  };
  const kind = status === "running" || status === "starting" ? "running"
    : status === "failed" ? "failed"
      : status === "aborted" || status === "interrupted" ? "stopped" : "completed";
  return (
    <svg
      className={kind === "running" ? "animate-spin" : undefined}
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...named}
    >
      {marks[kind]}
    </svg>
  );
}

interface RowProps {
  session: SessionInfo;
  /** The family's root: the chat on screen, or the session its subagents belong to. */
  main?: boolean;
  selected: boolean;
  running: boolean;
  usage?: SessionUsageSummary;
  onSelect(): void;
  tabShown?: boolean;
  onToggleTab?(): void;
  onNewSideChat?(): void;
  newSideChatPending?: boolean;
}

/** The family's root, drawn where a subagent row shows its run's mark. */
function MainGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

/** A side chat, drawn where a subagent row shows its run's mark. */
function SideChatGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" />
    </svg>
  );
}

/**
 * One agent on one line: its state as a mark, what it is, what it cost. The tooltip carries what
 * the line has no room for — the profile, the model and its reasoning level, when the session last
 * moved, the usage breakdown — the way a task card's line names the command and its tooltip holds
 * the whole one.
 */
function AgentRow({ session, main, selected, running, usage, onSelect, tabShown, onToggleTab, onNewSideChat, newSideChatPending }: RowProps) {
  const { locale, t } = useI18n();
  const relation = session.relation?.kind === "subagent" ? session.relation : null;
  const side = session.relation?.kind === "side";
  const status: SubagentSessionStatus = running ? "running" : relation?.status ?? "completed";
  const statusLabel = t(`agentSwitcher.status.${status}`);
  const primary = main ? t("agentSwitcher.main") : side ? sideChatTitle(session, t("agentSwitcher.sideChat")) : relation?.description || sessionTitle(session);
  const profile = side ? t("agentSwitcher.sideChat") : relation?.profile ?? t("agentSwitcher.subagent");
  const model = usage?.model ? `${usage.model.provider}/${usage.model.modelId}` : null;
  const thinkingLevel = usage?.thinkingLevel && usage.thinkingLevel !== "off" ? usage.thinkingLevel : null;
  const tip = [
    main ? sessionTitle(session) : [profile, model, thinkingLevel].filter(Boolean).join(" · "),
    statusLabel,
    formatRelativeTime(session.modified, locale),
    usage ? usageTooltip(usage, t, locale) : null,
  ].filter(Boolean).join("\n");
  return (
    <div className={`agent-row${selected ? " is-selected" : ""}`} title={tip}>
      <button type="button" role="option" aria-selected={selected} className="agent-open" onClick={onSelect}>
        <span className={`agent-glyph${running ? " is-running" : ""}${main ? " is-main" : ""}`}>
          {main ? <MainGlyph /> : side ? <SideChatGlyph /> : <StatusIcon status={status} label={statusLabel} />}
        </span>
        <span className="agent-name">{primary}</span>
        {hasUsage(usage) && <UsageLine usage={usage} />}
      </button>
      {onNewSideChat && (
        <button
          type="button"
          className="agent-tab"
          onClick={onNewSideChat}
          disabled={newSideChatPending}
          title={t("sideChat.new")}
          aria-label={t("sideChat.new")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" /><path d="M13 8.5v7M9.5 12h7" />
          </svg>
        </button>
      )}
      {onToggleTab && (
        <button
          type="button"
          className={`agent-tab${tabShown ? " is-shown" : ""}`}
          onClick={onToggleTab}
          disabled={selected}
          title={selected ? t("agentSwitcher.openInMainChat") : t(tabShown ? (side ? "sideChat.closeTab" : "subagent.closeTab") : side ? "sideChat.openTab" : "subagent.openTab")}
          aria-label={selected ? t("agentSwitcher.openInMainChat") : t(tabShown ? (side ? "sideChat.closeTab" : "subagent.closeTab") : side ? "sideChat.openTab" : "subagent.openTab")}
          aria-pressed={tabShown}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" />
            {tabShown && <path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4z" fill="currentColor" />}
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * The activity view's Agents section: the session on screen and every subagent it delegated, one
 * row each. A row opens that session in the chat; its side button toggles the transcript tab in the
 * rail, and the root's starts a side chat. The numbers are the family's own — the rows' and the
 * header's sum — counted the way the session info popover counts them, so the run's cost is
 * readable without opening it.
 */
export function ActivityAgents({
  rootSession,
  subagents,
  selectedSessionId,
  runningSessionIds,
  onSelectSession,
  openSubagentTabIds,
  onToggleSubagentTab,
  onNewSideChat,
}: ActivityAgentsProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [newSideChatPending, setNewSideChatPending] = useState(false);
  const [newSideChatError, setNewSideChatError] = useState<string | null>(null);
  const handleNewSideChat = async () => {
    setNewSideChatPending(true);
    setNewSideChatError(null);
    try {
      setNewSideChatError(await onNewSideChat());
    } catch (error) {
      setNewSideChatError(error instanceof Error ? error.message : String(error));
    } finally {
      setNewSideChatPending(false);
    }
  };
  const sortedSubagents = useMemo(() => [...subagents].sort((a, b) => {
    const aRunning = runningSessionIds.has(a.id);
    const bRunning = runningSessionIds.has(b.id);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  }), [runningSessionIds, subagents]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSubagents = normalizedQuery
    ? sortedSubagents.filter((session) => {
        const relation = session.relation?.kind === "subagent" ? session.relation : null;
        const sideLabel = session.relation?.kind === "side" ? t("agentSwitcher.sideChat") : null;
        return [relation?.description, relation?.profile, sideLabel, session.name, session.firstMessage]
          .some((value) => value?.toLowerCase().includes(normalizedQuery));
      })
    : sortedSubagents;
  const runningCount = countRunningSubagents(subagents, runningSessionIds);
  const familyIds = useMemo(() => [rootSession.id, ...subagents.map((session) => session.id)], [rootSession.id, subagents]);
  const runningKey = familyIds.filter((id) => runningSessionIds.has(id)).join(",");
  const usage = useAgentUsage(familyIds, runningKey);
  const familyUsage = useMemo(() => {
    const listed = familyIds.map((id) => usage[id]).filter(hasUsage);
    if (listed.length === 0) return null;
    const total: SessionUsageSummary = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      toolCalls: 0,
      totalActiveMs: 0,
    };
    for (const item of listed) {
      total.tokens.input += item.tokens.input;
      total.tokens.output += item.tokens.output;
      total.tokens.cacheRead += item.tokens.cacheRead;
      total.tokens.cacheWrite += item.tokens.cacheWrite;
      total.tokens.total += item.tokens.total;
      total.cost += item.cost;
      total.toolCalls += item.toolCalls;
      total.totalActiveMs += item.totalActiveMs;
    }
    return total;
  }, [familyIds, usage]);

  return (
    <section className="activity-section" role="listbox" aria-label={t("agentSwitcher.title")}>
      <div className="activity-section-head">
        <span className="activity-section-title">{t("agentSwitcher.title")}</span>
        <span className={`activity-section-count${runningCount > 0 ? " is-running" : ""}`}>
          {t(subagents.length === 1 ? "agentSwitcher.countOne" : "agentSwitcher.count", { count: subagents.length })}
          {runningCount > 0 && ` · ${t("agentSwitcher.runningCount", { count: runningCount })}`}
        </span>
        {familyUsage && (
          <span className="agent-total" title={t("agentSwitcher.totalUsageHint")}>
            <span className="agent-total-label">{t("agentSwitcher.totalUsage")}</span>
            <UsageLine usage={familyUsage} />
          </span>
        )}
      </div>
      {subagents.length > 8 && (
        <input
          type="search"
          className="agent-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("agentSwitcher.search")}
          aria-label={t("agentSwitcher.search")}
        />
      )}
      <div className="agent-rows">
        <AgentRow
          session={rootSession}
          main
          selected={rootSession.id === selectedSessionId}
          running={runningSessionIds.has(rootSession.id)}
          usage={usage[rootSession.id]}
          onSelect={() => onSelectSession(rootSession)}
          onNewSideChat={handleNewSideChat}
          newSideChatPending={newSideChatPending}
        />
        {newSideChatError && (
          <div className="agent-error" role="alert">{newSideChatError}</div>
        )}
        {visibleSubagents.map((session) => (
          <AgentRow
            key={session.id}
            session={session}
            selected={session.id === selectedSessionId}
            running={runningSessionIds.has(session.id)}
            usage={usage[session.id]}
            onSelect={() => onSelectSession(session)}
            tabShown={openSubagentTabIds.has(session.id)}
            onToggleTab={() => {
              if (session.relation?.kind === "side") {
                onToggleSubagentTab(session.id, t("sideChat.title"), true);
                return;
              }
              const relation = session.relation?.kind === "subagent" ? session.relation : null;
              onToggleSubagentTab(session.id, relation?.description || relation?.profile || sessionTitle(session));
            }}
          />
        ))}
        {visibleSubagents.length === 0 && (
          <div className="agent-empty">{t("agentSwitcher.noMatches")}</div>
        )}
      </div>
    </section>
  );
}
