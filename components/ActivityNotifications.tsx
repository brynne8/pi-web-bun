"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { RAIL_NOTIFICATION_LINGER_MS, railNotificationWindow, type RailNotification } from "@/lib/background-notifications";
import type { ReportStatus } from "@/lib/settled-report";

/**
 * The background results this session finished, as a list a person can read.
 *
 * The model learns about a finished command or subagent from a report; on screen a report was only
 * ever a card in the transcript, so someone who was not looking at that spot never knew it existed.
 * Each row is one result: what ran, how it ended, and whether the model has read it yet. A click
 * scrolls the transcript to the card that carries it. Newest first, three at a glance, the rest
 * behind one fold.
 */

interface Props {
  notifications: readonly RailNotification[];
  /** The rail's clock, ticking once a second: a read result lingers, then leaves. */
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
  // A result still on its way has no clock; one that has reached the model — delivered or taken —
  // leaves a buffer after that moment.
  const live = useMemo(
    () => notifications.filter((entry) => {
      const reachedAt = entry.consumed ? entry.consumedAtMs : entry.deliveredAtMs;
      return reachedAt === undefined || now - reachedAt < RAIL_NOTIFICATION_LINGER_MS;
    }),
    [notifications, now],
  );
  const { shown, hidden } = useMemo(() => railNotificationWindow(live), [live]);
  return (
    <section className="activity-section" aria-label={t("activity.notifications")}>
      <div className="activity-section-head">
        <span className="activity-section-title">{t("activity.notifications")}</span>
        {live.length > 0 && <span className="activity-section-count">{live.length}</span>}
      </div>
      {live.length === 0
        ? <div className="bg-tasks-empty">{t("activity.notificationsEmpty")}</div>
        : (
          <div className="agent-rows">
            {(showAll ? live : shown).map((entry) => (
              <NotificationRow
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
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
 * One result on one line: the fetch id a command answers to (or a subagent's description), how it
 * ended, and whether the model has it yet. A command's own text is not repeated here — it is in
 * the card this row opens, where there is room for it.
 */
function NotificationRow({ entry, onOpen }: { entry: RailNotification; onOpen(): void }) {
  const { t } = useI18n();
  // A result the model took has no card either — its report was withdrawn before it ever arrived —
  // but it is not on its way any more, so it says it was taken.
  const arriving = entry.entryId === undefined && !entry.consumed;
  const label = entry.kind === "bash" ? entry.id || entry.title : entry.title || entry.id;
  const ended = statusWord(entry.status, t);
  const tip = [entry.kind === "bash" ? entry.title : "", ended, clockTime(entry.finishedAtMs)].filter(Boolean).join("\n");
  const state = arriving
    ? <span className="notification-state">{t("activity.notificationArriving")}</span>
    : entry.consumed
      ? <span className="notification-state is-read">{t("activity.notificationTaken")}</span>
      : <span className="notification-state">{t("activity.notificationDelivered")}</span>;
  const body = (
    <>
      <span className="agent-glyph">
        <KindGlyph kind={entry.kind} />
      </span>
      <span className="agent-name">{label}</span>
      <span className="notification-state">{ended}</span>
      {state}
    </>
  );
  return (
    <div className={`agent-row${arriving ? " is-arriving" : ""}${entry.consumed ? " is-consumed" : ""}`}>
      {/* A row without a card is not a button: there is nothing to scroll to, taken or arriving. */}
      {entry.entryId === undefined
        ? <span className="agent-open" title={tip}>{body}</span>
        : <button type="button" className="agent-open" onClick={onOpen} title={tip}>{body}</button>}
    </div>
  );
}

/**
 * How the result ended, in the reader's language.
 *
 * A command that exited is a command that finished, whatever the code: a non-zero exit is the
 * command's own verdict on its work, not something this list asks a reader to weigh. The card and
 * the report keep the code for whoever needs it.
 */
function statusWord(status: ReportStatus, t: ReturnType<typeof useI18n>["t"]): string {
  switch (status.state) {
    case "completed":
    case "exit": return t("activity.notificationDone");
    case "signal": return t("activity.notificationSignal");
    case "stopped": return t("activity.notificationStopped");
    case "failed": return t("activity.notificationFailed");
  }
}

/** A finish time on the clock, not an age that counts up while the reader looks at it. */
function clockTime(at: number): string {
  if (!at) return "";
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
