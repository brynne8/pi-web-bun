"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { bgTaskState } from "@/lib/bg-task-status";
import { formatActiveDuration } from "@/lib/session-stats-format";
import type { BgTaskOutputResponse, BgTaskSummary } from "@/lib/bg-task-types";
import { AnsiText } from "./AnsiText";

const OUTPUT_POLL_MS = 900;
const OUTPUT_RETRY_BASE_MS = 800;
const OUTPUT_RETRY_MAX_MS = 5_000;
const OUTPUT_KEEP_CHARS = 200_000;
const OUTPUT_BOTTOM_SLACK_PX = 24;

interface Props {
  task: BgTaskSummary;
  /** Session titles by id, for the header's second line. */
  sessionTitles: ReadonlyMap<string, string>;
}

/** 24-grid stroke glyphs in `currentColor`, drawn to read at 12px like the debug panel's. */
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
 * One background task's log, as its own right-rail tab: the command's live output, tailed by byte
 * offset. A finished task reads its log once and stops; a running one keeps polling. The pane
 * follows a reader who is already at the bottom and otherwise offers the chat's own scroll arrow.
 */
export function BgTaskOutputView({ task, sessionTitles }: Props) {
  const { t } = useI18n();
  const [output, setOutput] = useState("");
  const [outputLoaded, setOutputLoaded] = useState(false);
  const [outputState, setOutputState] = useState<"loading" | "live" | "retrying" | "unavailable">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [commandOpen, setCommandOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const offsetRef = useRef(0);
  const followRef = useRef(true);
  const state = bgTaskState(task);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setOutput("");
    setOutputLoaded(false);
    setOutputState("loading");
    setFollow(true);
    followRef.current = true;
    offsetRef.current = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const decoder = new TextDecoder();
    const retry = () => {
      failures += 1;
      setOutputState("retrying");
      const delay = Math.min(OUTPUT_RETRY_MAX_MS, OUTPUT_RETRY_BASE_MS * 2 ** (failures - 1));
      timer = setTimeout(() => { void readOnce(false); }, delay);
    };
    const readOnce = async (first: boolean) => {
      const query = first || offsetRef.current === 0 ? "tail=65536" : `offset=${offsetRef.current}`;
      let response: Response;
      try {
        response = await fetch(`/api/bg-tasks/${encodeURIComponent(task.id)}/output?${query}`, { cache: "no-store" });
      } catch {
        if (!cancelled) retry();
        return;
      }
      if (cancelled) return;
      if (!response.ok) {
        setOutputState("unavailable");
        setOutputLoaded(true);
        return;
      }
      const body = await response.json() as BgTaskOutputResponse;
      if (cancelled) return;
      const bytes = Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0));
      // A finished task's last read flushes the decoder, so a character split across polls survives.
      const text = decoder.decode(bytes, { stream: body.running });
      offsetRef.current = body.offset;
      if (text) {
        setOutput((previous) => {
          const next = previous + text;
          return next.length > OUTPUT_KEEP_CHARS ? next.slice(next.length - OUTPUT_KEEP_CHARS) : next;
        });
      }
      failures = 0;
      setOutputLoaded(true);
      setOutputState("live");
      if (body.running) timer = setTimeout(() => { void readOnce(false); }, OUTPUT_POLL_MS);
    };
    void readOnce(true);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [task.id]);

  useEffect(() => {
    const pre = outputRef.current;
    if (!pre) return;
    if (followRef.current) pre.scrollTop = pre.scrollHeight;
  }, [output]);

  const handleOutputScroll = useCallback(() => {
    const pre = outputRef.current;
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= OUTPUT_BOTTOM_SLACK_PX;
    followRef.current = atBottom;
    setFollow(atBottom);
  }, []);

  const sessionTitle = sessionTitles.get(task.sessionId);
  const statusText = state === "running" || state === "stopping"
    ? `${state === "stopping" ? t("bgTasks.stopping") : t("bgTasks.running")} ${formatActiveDuration(now - task.startedAtMs)}`
    : state === "stopped"
      ? t("bgTasks.stopped")
      : state === "succeeded"
        ? `${t("bgTasks.succeeded")} ${formatActiveDuration((task.finishedAtMs ?? now) - task.startedAtMs)}`
        : state === "signal"
          ? t("bgTasks.signal")
          : `${t("bgTasks.failed")}${task.exitCode !== null ? ` · ${t("bgTasks.exitCode", { code: task.exitCode })}` : ""}`;

  return (
    <div className="bg-output">
      <div className="bg-output-head">
        <span className={`bg-task-glyph is-${state}`}>
          <KindGlyph
            kind={state === "succeeded" ? "ok" : state === "failed" || state === "signal" ? "error" : state === "stopped" ? "stopped" : "terminal"}
          />
        </span>
        {sessionTitle && <span className="bg-output-session" title={sessionTitle}>{sessionTitle}</span>}
        <span className={`bg-output-status is-${state}`}>{statusText}</span>
      </div>
      <div
        className="bg-output-command"
        onMouseEnter={() => setCommandOpen(true)}
        onMouseLeave={() => setCommandOpen(false)}
      >
        <code
          className="bg-output-command-text"
          tabIndex={0}
          onFocus={() => setCommandOpen(true)}
          onBlur={() => setCommandOpen(false)}
        >{task.command || t("bgTasks.unnamed")}</code>
        {commandOpen && (
          <code className="bg-output-command-full">{task.command || t("bgTasks.unnamed")}</code>
        )}
      </div>
      <div className="bg-output-body">
        <pre ref={outputRef} onScroll={handleOutputScroll} className="bg-task-output">
          {output ? <AnsiText text={output} /> : (
            <span className="bg-task-output-note">
              {outputState === "unavailable"
                ? t("bgTasks.outputUnavailable")
                : outputState === "retrying"
                  ? t("bgTasks.outputRetrying")
                  : outputLoaded
                    ? t("bgTasks.outputEmpty")
                    : t("bgTasks.outputLoading")}
            </span>
          )}
        </pre>
        {!follow && output.length > 0 && (
          <div className="bg-output-jump">
            <button
              type="button"
              className="chat-scroll-to-bottom is-visible"
              title={t("bgTasks.scrollToLatest")}
              aria-label={t("bgTasks.scrollToLatest")}
              onClick={() => {
                const pre = outputRef.current;
                if (pre) pre.scrollTop = pre.scrollHeight;
                followRef.current = true;
                setFollow(true);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
            </button>
          </div>
        )}
      </div>
      <style>{`
        .bg-output { display: flex; height: 100%; min-height: 0; flex-direction: column; background: var(--bg); }
        .bg-output .is-ok { color: var(--bt-ok); }
        .bg-output .is-error { color: var(--bt-err); }
        .bg-output-head {
          display: flex; flex-shrink: 0; align-items: center; gap: 7px; min-width: 0;
          padding: 7px 10px 5px;
          background: var(--bg-panel); font-size: 11px;
        }
        .bg-output-session {
          min-width: 0; flex: 1; overflow: hidden; color: var(--text-dim);
          font-size: 10px; text-overflow: ellipsis; white-space: nowrap;
        }
        .bg-output-command {
          position: relative; flex-shrink: 0; min-width: 0;
          padding: 0 10px 6px; border-bottom: 1px solid var(--border);
          background: var(--bg-panel); font-size: 11px; line-height: 1.45;
        }
        .bg-output-command-text {
          display: block; min-width: 0; overflow: hidden; color: var(--text);
          font-family: var(--font-mono); text-overflow: ellipsis; white-space: pre;
        }
        .bg-output-command-text:focus-visible { outline: none; }
        .bg-output-command-full {
          position: absolute; top: -7px; left: 1px; right: 1px; z-index: 3;
          max-height: 60vh; padding: 6px 8px; overflow: auto;
          color: var(--text); background: var(--bg-panel);
          font-family: var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere;
          border: 1px solid var(--border); border-radius: 6px;
          box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
        }
        .bg-output-status { flex-shrink: 0; color: var(--text-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
        .bg-output-status.is-running { color: var(--accent); }
        .bg-output-status.is-succeeded { color: var(--bt-ok); }
        .bg-output-status.is-failed, .bg-output-status.is-signal { color: var(--bt-err); }
        .bg-output-body { position: relative; display: flex; min-height: 0; flex: 1; }
        .bg-task-output {
          min-height: 0;
          flex: 1;
          margin: 0;
          padding: 10px;
          overflow: auto;
          background: var(--bg);
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 11px;
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .bg-task-output-note { color: var(--text-dim); font-style: italic; }
        .bg-output-jump { position: absolute; right: 12px; bottom: 12px; display: flex; justifyContent: center; pointer-events: none; z-index: 2; }
      `}</style>
    </div>
  );
}
