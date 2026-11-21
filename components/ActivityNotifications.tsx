"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { railNotificationWindow, type RailNotification } from "@/lib/background-notifications";
import { formatAgo } from "./debug-panel-state";

/**
 * The background results this session finished, as a list a person can read.
 *
 * The model learns about a finished command or subagent from a report; on screen a report was only
 * ever a card in the transcript, so someone who was not looking at that spot never knew it existed.
 * Each row is one result — its kind, its title, how it ended, how long ago — and a click scrolls the
 * transcript to the card that carries it. Newest first, three at a glance, the rest behind one fold.
 */

interface Props {
  notifications: readonly RailNotification[];
  /** The rail's clock, ticking once a second: every row says how long ago it finished. */
  now: number;
  /** Scrolls the chat to the report's card. Never called for a report still on its way there. */
  onOpenNotification(entryId: string): void;
}

/** A 24-grid stroke glyph: the terminal for a command, the robot for a subagent. */
function KindGlyph({ kind }: { kind: RailNotification["kind"] }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "bash"
        ? <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>
        : <><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></>}
    </svg>
  );
}

export function ActivityNotifications({ notifications, now, onOpenNotification }: Props) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const { shown, hidden } = useMemo(() => railNotificationWindow(notifications), [notifications]);
  return (
    <section className="activity-section" aria-label={t("activity.notifications")}>
      <div className="activity-section-head">
        <span className="activity-section-title">{t("activity.notifications")}</span>
        {notifications.length > 0 && <span className="activity-section-count">{notifications.length}</span>}
      </div>
      {notifications.length === 0
        ? <div className="bg-tasks-empty">{t("activity.notificationsEmpty")}</div>
        : (
          <div className="agent-rows">
            {(showAll ? notifications : shown).map((entry) => (
              <NotificationRow
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                now={now}
                onOpen={() => entry.entryId && onOpenNotification(entry.entryId)}
              />
            ))}
            {hidden > 0 && (
              <button type="button" className="agent-fold" onClick={() => setShowAll((open) => !open)} aria-expanded={showAll}>
                {showAll ? t("agentSwitcher.showLess") : t("activity.notificationsMore", { count: hidden })}
              </button>
            )}
          </div>
        )}
    </section>
  );
}

/**
 * One result on one line. A result still on its way has no card to scroll to, so it is not a
 * button: it says it is arriving and waits, the way the done chime does.
 */
function NotificationRow({ entry, now, onOpen }: { entry: RailNotification; now: number; onOpen(): void }) {
  const { t } = useI18n();
  const arriving = entry.entryId === undefined;
  const when = arriving ? t("activity.notificationArriving") : formatAgo(now - entry.finishedAtMs, t);
  const tip = [entry.title, `${t("activity.notificationOutcome")}: ${entry.outcome}`, when].join("\n");
  const body = (
    <>
      <span className="agent-glyph">
        <KindGlyph kind={entry.kind} />
      </span>
      <span className="agent-name">{entry.title || entry.id}</span>
      <span className="notification-when">{when}</span>
    </>
  );
  return (
    <div className={`agent-row${arriving ? " is-arriving" : ""}`}>
      {arriving
        ? <span className="agent-open" title={tip}>{body}</span>
        : <button type="button" className="agent-open" onClick={onOpen} title={tip}>{body}</button>}
    </div>
  );
}
