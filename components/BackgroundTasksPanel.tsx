"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { bgTaskState } from "@/lib/bg-task-status";
import { formatActiveDuration } from "@/lib/session-stats-format";
import type { BgTaskSummary } from "@/lib/bg-task-types";
import type { DebugClientSession } from "@/lib/debug-types";
import type { SessionInfo } from "@/lib/types";
import { DebugPanel, DebugPanelBoundary } from "./DebugPanel";

/** A task that has written nothing for this long is worth noticing. */
const STALE_AFTER_MS = 30_000;

interface Props {
  tasks: BgTaskSummary[];
  /** Session titles by id, for a card's tooltip. */
  sessionTitles: ReadonlyMap<string, string>;
  /** Opens a task's log as its own right-rail tab. */
  onOpenTask(taskId: string): void;
  onRefresh: () => Promise<void> | void;
  /** The chat's snapshot reader and the catalog the embedded debug read-out needs. */
  debug: {
    readerRef: RefObject<(() => DebugClientSession) | null>;
    selectedSessionId: string | null;
    sessions: readonly SessionInfo[];
  };
}

function firstLine(command: string): string {
  return command.split("\n")[0] || command;
}

/** 24-grid stroke glyphs in `currentColor`, drawn to read at 12px like the debug read-out's. */
function KindGlyph({ kind, size = 12 }: { kind: "terminal" | "ok" | "error" | "stopped"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {kind === "terminal" && (<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>)}
      {kind === "ok" && (<><polyline points="20 6 9 17 4 12" /></>)}
      {kind === "error" && (<><path d="M18 6 6 18M6 6l12 12" /></>)}
      {kind === "stopped" && (<><rect x="6" y="6" width="12" height="12" rx="1" /></>)}
    </svg>
  );
}

/**
 * The right rail's activity view: what this instance is doing right now. Connections and sessions
 * come first — they are the context, one light line each — and the commands under them, because a
 * grid of task cards is the heavy content and would push the context out of sight the other way
 * round. One panel, one scroll, one palette: a task card and a stream row read the same because
 * they are drawn from the same tokens. A task's log opens as its own tab (`BgTaskOutputView`), so
 * nothing overlays the grid.
 */
export function BackgroundTasksPanel({
  tasks,
  sessionTitles,
  onOpenTask,
  onRefresh,
  debug,
}: Props) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [killingId, setKillingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runningCount = tasks.filter((task) => task.finishedAtMs === null).length;
  // The panel's identity and its count in one line. The tab badge is the same number, condensed.
  const head = (
    <div className="activity-head">
      <span className="activity-title">{t("bgTasks.tab")}</span>
      <span className={`activity-count${runningCount > 0 ? " is-running" : ""}`}>
        {t("bgTasks.runningCount", { count: runningCount })}
      </span>
    </div>
  );

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

  if (tasks.length === 0 && runningCount === 0) {
    return (
      <div className="activity-panel">
        {head}
        <div className="activity-scroll">
          <section className="activity-section">
            <div className="activity-section-head">
              <span className="activity-section-title">{t("activity.connections")}</span>
            </div>
            <DebugPanelBoundary fallback={t("debug.failed")}>
              <DebugPanel
                readerRef={debug.readerRef}
                selectedSessionId={debug.selectedSessionId}
                sessions={debug.sessions}
                embedded
              />
            </DebugPanelBoundary>
          </section>
          <div className="bg-tasks-empty">{t("bgTasks.empty")}</div>
        </div>
        <style>{ACTIVITY_PANEL_CSS}</style>
      </div>
    );
  }

  return (
    <div className="activity-panel">
      {head}
      <div className="activity-scroll">
        <section className="activity-section">
          <div className="activity-section-head">
            <span className="activity-section-title">{t("activity.connections")}</span>
          </div>
          <DebugPanelBoundary fallback={t("debug.failed")}>
            <DebugPanel
              readerRef={debug.readerRef}
              selectedSessionId={debug.selectedSessionId}
              sessions={debug.sessions}
              embedded
            />
          </DebugPanelBoundary>
        </section>

        <section className="activity-section">
          <div className="activity-section-head">
            <span className="activity-section-title">{t("bgTasks.title")}</span>
          </div>
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
        </section>

        {error && <div className="bg-task-error" role="status">{error}</div>}
      </div>

      <style>{ACTIVITY_PANEL_CSS}</style>
    </div>
  );
}

/**
 * One fused view: one palette, one scroll, one section language. `--act-*` is the panel's own and
 * the debug read-out inherits it, so a warning reads the same on a task card and on a stream row.
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
  .activity-head {
    display: flex;
    flex-shrink: 0;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 9px 12px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .activity-title { flex-shrink: 0; color: var(--text); font-size: 12px; font-weight: 700; }
  .activity-count { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
  .activity-count.is-running { color: var(--accent); }
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
    min-height: 48px;
    align-items: center;
    justify-content: center;
    padding: 12px;
    color: var(--text-dim);
    font-size: 12px;
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
  }
`;
