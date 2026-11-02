"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { copyText } from "@/lib/clipboard";
import type { DebugClientSession } from "@/lib/debug-types";
import {
  DEBUG_TICK_MS,
  EMPTY_DEBUG_SAMPLES,
  EMPTY_DEBUG_SERVER_READING,
  createDebugPoller,
  debugPollSample,
  debugTargetSessionId,
  pushDebugSample,
  readClientSession,
  readDebugPage,
  runningPollSample,
  type DebugPageReading,
  type DebugSamples,
  type DebugServerReading,
} from "./debug-panel-state";

/** The three readings one render shows together. */
export interface DebugReadoutReading {
  page: DebugPageReading | null;
  server: DebugServerReading;
  samples: DebugSamples;
}

export interface DebugReadout extends DebugReadoutReading {
  /** The reading a render shows: the held one while the mouse rests on a tooltip, the live one else. */
  shown: DebugReadoutReading;
  copied: boolean;
  copyJson(): void;
  /** The read-out's own element, for the tooltip-hold listener. */
  panelRef: RefObject<HTMLElement | null>;
}

interface Params {
  /** The chat's snapshot reader, registered by ChatWindow; read in the tick, never in render. */
  readerRef: RefObject<(() => DebugClientSession) | null>;
  selectedSessionId: string | null;
  /** How often to ask the server, in ms: the read-out's own beat once its numbers are open to be
   * read, a slower one while they are folded. The page's own readings run on their own tick either
   * way, so a folded read-out still sees a stream go quiet. */
  pollingMs: number;
}

/**
 * What the activity view's read-out holds: the page's own reading on its 1 s tick, the server's
 * snapshot on `pollingMs`, and the round-trip samples of both. Only the numbers behind the fold
 * want the fast beat; the sessions' countdowns and the faults — a stream that went quiet, a
 * starved connection pool, a lease that never answered — are read off the page or answered slowly.
 */
export function useDebugReadout({ readerRef, selectedSessionId, pollingMs }: Params): DebugReadout {
  const selectedRef = useRef(selectedSessionId);
  selectedRef.current = selectedSessionId;
  const pollerRef = useRef<ReturnType<typeof createDebugPoller> | null>(null);
  const disposedRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The read-out's element, for the tooltip-hold listener below.
  const panelRef = useRef<HTMLElement | null>(null);
  // The running poll's last record seen, so each poll is one sample.
  const lastRunningAtRef = useRef<number | null>(null);
  const [page, setPage] = useState<DebugPageReading | null>(null);
  const [server, setServer] = useState<DebugServerReading>(EMPTY_DEBUG_SERVER_READING);
  const [samples, setSamples] = useState<DebugSamples>(EMPTY_DEBUG_SAMPLES);
  const [copied, setCopied] = useState(false);
  // What the view shows while the mouse rests on something with a tooltip: each tick would rewrite
  // the title under it, and the browser hides and shows again a tooltip whose text changed, so it
  // flickered every second. Readings go on underneath; the view catches up as the mouse moves off.
  const [held, setHeld] = useState<DebugReadoutReading | null>(null);
  const liveRef = useRef<DebugReadoutReading>({ page, server, samples });
  liveRef.current = { page, server, samples };

  useEffect(() => {
    const section = panelRef.current;
    if (!section) return;
    let heldOn: Element | null = null;
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const titled = event.target instanceof Element ? event.target.closest("[title]") : null;
      const target = titled && section.contains(titled) ? titled : null;
      if (target === heldOn) return;
      heldOn = target;
      // Another tooltip: the view as it is now, held from here.
      setHeld(target ? liveRef.current : null);
    };
    const onPointerLeave = () => {
      heldOn = null;
      setHeld(null);
    };
    section.addEventListener("pointerover", onPointerOver);
    section.addEventListener("pointerleave", onPointerLeave);
    return () => {
      section.removeEventListener("pointerover", onPointerOver);
      section.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    const poller = createDebugPoller({
      fetch: (url, init) => fetch(url, init),
      sessionId: () => debugTargetSessionId(readClientSession(readerRef.current).client, selectedRef.current),
      isVisible: () => document.visibilityState === "visible",
      onReading: (reading) => {
        setServer(reading);
        const sample = debugPollSample(reading);
        if (sample) setSamples((current) => ({ ...current, poll: pushDebugSample(current.poll, sample) }));
      },
    });
    pollerRef.current = poller;
    const read = () => {
      const reading = readDebugPage(readerRef.current, poller.inFlightSince());
      setPage(reading);
      const last = reading.runningPoll?.last ?? null;
      if (last && last.at !== lastRunningAtRef.current) {
        lastRunningAtRef.current = last.at;
        const sample = runningPollSample(last);
        if (sample) setSamples((current) => ({ ...current, running: pushDebugSample(current.running, sample) }));
      }
    };
    read();
    const tick = window.setInterval(() => {
      // A hidden page shows nothing: no render each second for it, as the poll pauses too.
      if (document.visibilityState !== "visible") return;
      read();
      // A session picked in the sidebar: ask about it now, not at the next poll.
      poller.sync();
    }, DEBUG_TICK_MS);
    poller.poll();
    const pollTimer = window.setInterval(() => poller.poll(), pollingMs);
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      read();
      poller.poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      // Disposed first: an answer still on its way never reaches the state.
      disposedRef.current = true;
      poller.dispose();
      pollerRef.current = null;
      window.clearInterval(tick);
      window.clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [readerRef, pollingMs]);

  useEffect(() => {
    pollerRef.current?.sync();
  }, [selectedSessionId]);

  const copyJson = useCallback(() => {
    const payload = { client: liveRef.current.page, server: liveRef.current.server.reply };
    void copyText(JSON.stringify(payload, null, 2)).then(() => {
      if (disposedRef.current) return;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1400);
    }, () => {});
  }, []);

  return { page, server, samples, shown: held ?? { page, server, samples }, copied, copyJson, panelRef };
}
