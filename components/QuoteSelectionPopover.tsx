"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { useI18n } from "@/hooks/useI18n";
import type { ChatInputHandle } from "./ChatInput";

interface Props {
  /** The transcript a selection must sit in for the popover to offer it. */
  rootRef: RefObject<HTMLElement | null>;
  chatInputRef?: RefObject<ChatInputHandle | null>;
}

/**
 * The selected-text popover (Settings › General). Its state lives here, not in
 * ChatWindow: a selection made or cleared re-renders this popover alone, never
 * the transcript, whose render grows with every loaded turn. Upstream also
 * offers "Ask in side chat" here; this fork's side chat starts from `/btw`.
 */
export function QuoteSelectionPopover({ rootRef, chatInputRef }: Props) {
  const { t } = useI18n();
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
  }, []);

  useEffect(() => {
    const captureQuotedSelection = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!selection || selection.isCollapsed || !range || !root.contains(range.commonAncestorContainer)) {
        setQuotedSelection(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setQuotedSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setQuotedSelection({
        text,
        top: Math.min(window.innerHeight - 44, rect.bottom + 8),
        left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      });
    };
    document.addEventListener("pointerup", captureQuotedSelection);
    return () => document.removeEventListener("pointerup", captureQuotedSelection);
  }, [rootRef]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!quotePopoverRef.current?.contains(event.target as Node)) closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, closeQuotedSelection]);

  const quoteSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertQuote(buildQuotedSelection(quotedSelection.text));
    // No `removeAllRanges()` here: inserting focuses the composer, and that
    // focus already collapses the page's selection. Calling it afterwards also
    // clears the composer's own selection and drops its caret to offset 0
    // (#1319), so the quote would be typed in front of instead of after.
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection]);

  if (!quotedSelection) return null;
  return createPortal(
    <div
      ref={quotePopoverRef}
      role="toolbar"
      aria-label={t("chat.selectionActions")}
      style={{
        position: "fixed",
        top: quotedSelection.top,
        left: quotedSelection.left,
        zIndex: 260,
        display: "flex",
        flexWrap: "wrap",
        gap: 3,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
        overflowY: "auto",
        padding: 3,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg)",
        boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
      }}
    >
      <button
        type="button"
        className="file-viewer-icon-button"
        title={t("chat.quoteSelection")}
        aria-label={t("chat.quoteSelection")}
        onPointerDown={(event) => event.preventDefault()}
        onClick={quoteSelectionHere}
        style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
          <path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z" />
        </svg>
        <span>{t("chat.quoteSelection")}</span>
      </button>
    </div>,
    document.body,
  );
}
