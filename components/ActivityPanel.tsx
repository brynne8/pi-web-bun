"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { bgTaskState } from "@/lib/bg-task-status";
import { formatActiveDuration, formatCompactCount } from "@/lib/session-stats-format";
import type { BgTaskSummary } from "@/lib/bg-task-types";
import type { DebugClientSession } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { ActivityAgents, type ActivityAgentsProps } from "./ActivityAgents";
import {
  DIAGNOSTICS_CSS,
  DiagnosticsNumbers,
  DiagnosticsSessions,
  DiagnosticsBoundary,
  IssueList,
  debugFaults,
  debugStreamSummary,
} from "./ActivityDiagnostics";
import { DEBUG_POLL_MS } from "./debug-panel-state";
import { useDebugReadout } from "./debug-readout";
import { sessionRowTitle } from "./SessionTree";

/** A task that has written nothing for this long is worth noticing. */
const STALE_AFTER_MS = 30_000;
// The numbers are open by default, so this beat belongs to the folded case alone: often enough to
// keep the session rows' countdowns honest, and the read-out's own 2 s returns when they are open.
const SLOW_POLL_MS = 5000;

interface Props {
  tasks: BgTaskSummary[];
  /** Session titles by id, for a card's tooltip. */
  sessionTitles: ReadonlyMap<string, string>;
  /** Opens a task's log as its own right-rail tab. */
  onOpenTask(taskId: string): void;
  onRefresh: () => Promise<void> | void;
  /** The chat's snapshot reader and the session catalog the read-out names its sessions from. */
  readerRef: RefObject<(() => DebugClientSession) | null>;
  selectedSessionId: string | null;
  sessions: readonly SessionInfo[];
  /** The session on screen and what it delegated; null while no chat is shown. */
  agents: ActivityAgentsProps | null;
}

function firstLine(command: string): string {
  return command.split("\n")[0] || command;
}

/** 24-grid stroke glyphs in `currentColor`, drawn to read at 12px like the read-out's. */
function KindGlyph({ kind, size = 12 }: { kind: "terminal" | "ok" | "error" | "stopped"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "terminal" && (<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>)}
      {kind === "ok" && (<><polyline points="20 6 9 17 4 12" /></>)}
      {kind === "error" && (<><path d="M18 6 6 18M6 6l12 12" /></>)}
      {kind === "stopped" && (<><rect x="6" y="6" width="12" height="12" rx="1" /></>)}
    </svg>
  );
}

/**
 * The right rail's activity view: what the session on screen is doing right now, ordered by what a
 * reader can do about it — what is wrong, who is working, what is running, which sessions the server
 * holds — with the measurements of all that behind one fold, open by default and on the slow beat
 * once closed. One panel, one scroll, one palette (`--act-*`, which the read-out's `--dbg-*` resolve
 * to, so a warning reads the same on a task card and on a stream row).
 */
export function ActivityPanel({
  tasks,
  sessionTitles,
  onOpenTask,
  onRefresh,
  readerRef,
  selectedSessionId,
  sessions,
  agents,
}: Props) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readout = useDebugReadout({ readerRef, selectedSessionId, pollingMs: detailsOpen ? DEBUG_POLL_MS : SLOW_POLL_MS });
  const { page, server, shown } = readout;
  const runningCount = tasks.filter((task) => task.finishedAtMs === null).length;
  const titleOf = useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return (id: string) => {
      const info = byId.get(id);
      return info ? sessionRowTitle(info) : null;
    };
  }, [sessions]);
  const issues = debugFaults({ page, server, selectedSessionId, titleOf, t });
  const summary = debugStreamSummary(page, t);
  // How many sessions the server holds something for, once it has answered; nothing before that.
  const sessionsShown = server.reply ? formatCompactCount(server.reply.sessions.length) : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Stop takes two clicks: the first arms the card for five seconds, the second stops it.
  useEffect(() => {
    if (!confirmingId) return;
    const timer = setTimeout(() => setConfirmingId(null), 5_000);
    return () => clearTimeout(timer);
  }, [confirmingId]);

  // Keep a sensible card highlighted: the selected one while it is listed, otherwise the first
  // running task, otherwise the most recently started finished one.
  useEffect(() => {
    if (selectedId && tasks.some((task) => task.id === selectedId)) return;
    setSelectedId((tasks.find((task) => task.finishedAtMs === null) ?? tasks[0])?.id ?? null);
  }, [selectedId, tasks]);

  const stopTask = useCallback(async (task: BgTaskSummary) => {
    if (killingId) return;
    if (confirmingId !== task.id) {
      setConfirmingId(task.id);
      return;
    }
    setConfirmingId(null);
    setKillingId(task.id);
    setError(null);
    try {
      const response = await fetch(`/api/bg-tasks/${encodeURIComponent(task.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "kill" }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        setError(typeof body.error === "string" ? body.error : t("bgTasks.stopFailed", { error: response.statusText }));
      }
      await onRefresh();
    } catch (cause) {
      setError(t("bgTasks.stopFailed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setKillingId(null);
    }
  }, [confirmingId, killingId, onRefresh, t]);

  return (
    <div className="activity-panel">
      {/* The read-out's tooltip hold listens here: a title that changed under the pointer is one
          the browser hides and shows again, so the readings it names are held until it moves off. */}
      <section className="activity-scroll" ref={readout.panelRef}>
        {issues.length > 0 && (
          <section className="activity-section">
            <div className="activity-section-head">
              <span className="activity-section-title">{t("activity.problems")}</span>
              <span className="activity-section-count is-running">{issues.length}</span>
            </div>
            {/* Plain text, no live region: a screen reader would read out every change. */}
            <IssueList issues={issues} />
          </section>
        )}

        {agents && (
          <ActivityAgents {...agents} />
        )}

        <section className="activity-section">
          <div className="activity-section-head">
            <span className="activity-section-title">{t("bgTasks.title")}</span>
            <span className={`activity-section-count${runningCount > 0 ? " is-running" : ""}`}>
              {t("bgTasks.runningCount", { count: runningCount })}
            </span>
          </div>
          {tasks.length === 0 ? (
            <div className="bg-tasks-empty">{t("bgTasks.empty")}</div>
          ) : (
            <div className="bg-task-grid">
              {tasks.map((task) => {
                const state = bgTaskState(task);
                const running = state === "running" || state === "stopping";
                const idleMs = Math.max(0, now - task.lastOutputAtMs);
                const stale = state === "running" && idleMs >= STALE_AFTER_MS;
                const elapsedMs = (task.finishedAtMs ?? now) - task.startedAtMs;
                const sessionTitle = sessionTitles.get(task.sessionId);
                // The card's own line says what it is; the tooltip carries the command in full, the
                // session it belongs to, and the state a colour or a word alone cannot.
                const tip = [
                  task.command,
                  sessionTitle ? `${t("bgTasks.sessionLabel")}: ${sessionTitle}` : task.sessionId,
                  state === "running"
                    ? `${t("bgTasks.running")} ${formatActiveDuration(elapsedMs)} · ${t("bgTasks.idle", { duration: formatActiveDuration(idleMs) })}`
                    : state === "stopping"
                      ? t("bgTasks.stopping")
                      : state === "stopped"
                        ? t("bgTasks.stopped")
                        : state === "succeeded"
                          ? `${t("bgTasks.succeeded")} ${formatActiveDuration(elapsedMs)}`
                          : state === "signal"
                            ? t("bgTasks.signal")
                            : `${t("bgTasks.failed")}${task.exitCode !== null ? ` · ${t("bgTasks.exitCode", { code: task.exitCode })}` : ""}`,
                ].join("\n");
                return (
                  <div
                    key={task.id}
                    className={`bg-task-card is-${state}${task.id === selectedId ? " is-selected" : ""}`}
                    title={tip}
                  >
                    <button
                      type="button"
                      className="bg-task-open"
                      onClick={() => { setSelectedId(task.id); onOpenTask(task.id); }}
                      aria-label={firstLine(task.command)}
                    >
                      <span className={`bg-task-glyph is-${state}`}>
                        <KindGlyph
                          kind={state === "succeeded" ? "ok" : state === "failed" || state === "signal" ? "error" : state === "stopped" ? "stopped" : "terminal"}
                        />
                      </span>
                      <span className="bg-task-name">{firstLine(task.command) || t("bgTasks.unnamed")}</span>
                    </button>
                    <span className={`bg-task-badge is-${state}${stale ? " is-stale" : ""}`}>
                      {state === "running" || state === "stopping"
                        ? formatActiveDuration(elapsedMs)
                        : state === "stopped"
                          ? t("bgTasks.stopped")
                          : state === "succeeded"
                            ? formatActiveDuration(elapsedMs)
                            : state === "signal"
                              ? t("bgTasks.signal")
                              : t("bgTasks.exitCode", { code: task.exitCode ?? "?" })}
                    </span>
                    {running && (
                      <button
                        type="button"
                        className={`bg-task-stop${confirmingId === task.id ? " is-confirming" : ""}`}
                        disabled={killingId === task.id || state === "stopping"}
                        onClick={(event) => {
                          event.stopPropagation();
                          void stopTask(task);
                        }}
                        title={t("bgTasks.stopTitle")}
                        aria-label={t("bgTasks.stopTitle")}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {error && <div className="bg-task-error" role="status">{error}</div>}

        <section className="activity-section">
          <div className="activity-section-head">
            <span className="activity-section-title">{t("activity.sessions")}</span>
            {sessionsShown !== null && <span className="activity-section-count">{sessionsShown}</span>}
          </div>
          <DiagnosticsBoundary fallback={t("debug.failed")}>
            <DiagnosticsSessions
              page={shown.page}
              server={shown.server}
              samples={readout.samples}
              selectedSessionId={selectedSessionId}
              sessions={sessions}
              t={t}
            />
          </DiagnosticsBoundary>
        </section>

        <section className="activity-section">
          <div className="activity-section-head">
            <button
              type="button"
              className="activity-disclosure"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((open) => !open)}
              title={t("debug.readOnly")}
            >
              <svg className={`activity-chevron${detailsOpen ? " is-open" : ""}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
              <span className="activity-section-title">{t("activity.diagnostics")}</span>
              {!detailsOpen && summary && <span className="activity-section-count">{summary}</span>}
            </button>
            {detailsOpen && (
              <button type="button" className="activity-copy" onClick={readout.copyJson} title={t("debug.copyTitle")}>
                {readout.copied ? t("debug.copied") : t("debug.copyJson")}
              </button>
            )}
          </div>
          {detailsOpen && (
            <DiagnosticsBoundary fallback={t("debug.failed")}>
              <DiagnosticsNumbers
                page={shown.page}
                server={shown.server}
                samples={readout.samples}
                selectedSessionId={selectedSessionId}
                sessions={sessions}
                t={t}
              />
            </DiagnosticsBoundary>
          )}
        </section>
      </section>

      <style>{ACTIVITY_PANEL_CSS}</style>
      <style>{DIAGNOSTICS_CSS}</style>
    </div>
  );
}

/**
 * One fused view: one palette, one scroll, one section language. `--act-*` is the panel's own and
 * the read-out inherits it, so a warning reads the same on a task card and on a stream row. Every
 * row of it is 11px on one line: the section head's title, then what it says about itself.
 */
const ACTIVITY_PANEL_CSS = `
  .activity-panel {
    --act-ok: #16a34a;
    --act-warn: #d97706;
    --act-err: #ef4444;
    display: flex;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: var(--bg);
    font-size: 12px;
    line-height: 1.5;
  }
  .activity-scroll {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
    padding: 12px 0;
  }
  .activity-section { display: flex; flex-shrink: 0; flex-direction: column; gap: 7px; padding: 0 12px; }
  .activity-section-head { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .activity-section-title { color: var(--text); font-size: 11px; font-weight: 700; }
  .activity-section-count { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
  .activity-section-count.is-running { color: var(--accent); }
  .activity-disclosure {
    display: flex;
    min-width: 0;
    align-items: baseline;
    gap: 5px;
    margin-left: -4px;
    padding: 2px 4px;
    border: none;
    border-radius: 4px;
    background: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .activity-disclosure:hover { background: var(--bg-hover); }
  .activity-disclosure .activity-section-title { color: var(--text-muted); }
  .activity-disclosure:hover .activity-section-title { color: var(--text); }
  .activity-chevron { flex-shrink: 0; align-self: center; color: var(--text-dim); transition: transform 0.12s; }
  .activity-chevron.is-open { transform: rotate(90deg); }
  .activity-copy {
    flex-shrink: 0;
    margin-left: auto;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 10px;
  }
  .activity-copy:hover { background: var(--bg-hover); color: var(--text); }
  .agent-rows { display: flex; flex-direction: column; gap: 2px; }
  .agent-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 4px;
    border-left: 2px solid transparent;
    border-radius: 4px;
  }
  .agent-row:hover { background: var(--bg-hover); }
  .agent-row.is-selected { border-left-color: var(--accent); background: var(--bg-selected); }
  .agent-open {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 7px;
    padding: 4px 4px 4px 6px;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-size: 11px;
    text-align: left;
  }
  .agent-glyph { display: inline-flex; flex-shrink: 0; color: var(--text-dim); }
  .agent-glyph.is-main { color: var(--text-muted); }
  .agent-glyph.is-running { color: var(--accent); }
  .agent-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-row.is-selected .agent-name { color: var(--text); }
  .agent-total { margin-left: auto; display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
  .agent-total-label { color: var(--text-dim); font-size: 10px; }
  .agent-search {
    width: 100%;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg);
    color: var(--text);
    font-size: 11px;
    outline: none;
  }
  .agent-search:focus { border-color: var(--accent); }
  .agent-empty { padding: 8px; color: var(--text-dim); font-size: 11px; text-align: center; }
  .agent-tab {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-right: 2px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, background 0.12s, color 0.12s;
  }
  .agent-row:hover .agent-tab,
  .agent-tab:focus-visible,
  .agent-tab.is-shown { opacity: 1; }
  .agent-tab:hover { background: var(--bg-selected); color: var(--text); }
  .agent-tab.is-shown { color: var(--accent); }
  .bg-task-error {
    flex-shrink: 0;
    margin: 0 12px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--act-err) 45%, transparent);
    border-radius: 6px;
    color: var(--act-err);
    font-size: 11px;
  }
  .bg-task-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
    gap: 6px;
  }
  .bg-tasks-empty {
    display: flex;
    min-height: 32px;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-size: 11px;
    text-align: center;
  }
  .bg-task-card {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 7px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    font-size: 11px;
  }
  .bg-task-card:hover { background: var(--bg-hover); }
  .bg-task-card.is-selected { border-color: var(--accent); }
  .bg-task-open {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: none;
    color: var(--text);
    cursor: pointer;
    font-size: inherit;
    text-align: left;
  }
  .bg-task-glyph { display: inline-flex; color: var(--text-dim); }
  .bg-task-glyph.is-running { color: var(--accent); }
  .bg-task-glyph.is-stopping { color: var(--text-dim); }
  .bg-task-glyph.is-succeeded { color: var(--act-ok); }
  .bg-task-glyph.is-failed, .bg-task-glyph.is-signal { color: var(--act-err); }
  .bg-task-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--text-muted);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bg-task-badge {
    flex-shrink: 0;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bg-task-badge.is-running { border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); }
  .bg-task-badge.is-running.is-stale { border-color: var(--act-warn); color: var(--act-warn); }
  .bg-task-badge.is-succeeded { border-color: color-mix(in srgb, var(--act-ok) 45%, transparent); color: var(--act-ok); }
  .bg-task-badge.is-failed, .bg-task-badge.is-signal { border-color: color-mix(in srgb, var(--act-err) 45%, transparent); color: var(--act-err); }
  .bg-task-badge.is-stopped, .bg-task-badge.is-stopping { color: var(--text-dim); }
  .bg-task-stop {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, background 0.12s, color 0.12s;
  }
  .bg-task-card:hover .bg-task-stop,
  .bg-task-stop:focus-visible,
  .bg-task-stop.is-confirming { opacity: 1; }
  .bg-task-stop:hover { background: var(--bg-selected); color: var(--text); }
  .bg-task-stop.is-confirming { color: var(--act-err); }
  .bg-task-stop:disabled { cursor: default; color: var(--text-dim); }
  .bg-task-open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-radius: 3px;
  }
  @media (pointer: coarse) {
    .bg-task-stop { width: 32px; height: 32px; opacity: 1; }
    .bg-task-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    .agent-tab { width: 32px; height: 32px; opacity: 1; }
  }
`;
