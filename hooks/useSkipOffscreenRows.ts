"use client";

import { useCallback, type RefObject } from "react";

/** How far past the scroll container's edges a row stays laid out, as a share of its height. */
const NEAR_MARGIN = "100% 0px";
/** A width change re-measures the skipped rows once it has settled. */
const RESIZE_SETTLE_MS = 200;

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
  }
  return null;
}

/**
 * Lets the browser skip the layout of transcript rows far outside the scroll
 * container (`content-visibility: auto`), so work that scales with the laid-out
 * document stays the size of the screen however many turns are loaded: Chrome's
 * selection sync on every mouse press took 42 ms with 300 turns loaded, 1.5 ms
 * with the rows off screen skipped.
 *
 * A skipped row is held to its own box height, which `.chat-rows` being a flex column
 * makes equal to the room the row takes: each row is its own formatting context and its
 * own margins are its own, so a row is one size lying plain and another skipped, and
 * folding one moves neither the view nor the scrollbar. Near the screen a row is plain
 * again: no containment clips its focus rings or shadows there. The returned callback
 * ref goes on the element whose children are the rows.
 */
export function useSkipOffscreenRows(rowsRef?: RefObject<HTMLElement | null>) {
  return useCallback((rows: HTMLElement | null) => {
    if (rowsRef) rowsRef.current = rows;
    if (!rows) return;
    const scroller = scrollParent(rows);
    if (!scroller || typeof IntersectionObserver === "undefined" || !CSS.supports?.("content-visibility", "auto")) {
      return () => { if (rowsRef) rowsRef.current = null; };
    }

    const near = new Set<Element>();
    const skipped = new Set<HTMLElement>();
    const unskip = (row: HTMLElement) => {
      row.style.removeProperty("content-visibility");
      row.style.removeProperty("contain-intrinsic-block-size");
      row.style.removeProperty("contain");
      skipped.delete(row);
    };
    // A size read at one moment can be wrong at the next: the width changed, and with
    // it how the row's text wraps. Whatever the cause, rows outside the viewport moving
    // must not move the row the reader is on, so it is put back. A row crossing the band
    // is never inside the viewport, so the anchor is never one of the rows being changed.
    const holdWhile = (change: () => void) => {
      const top = scroller.getBoundingClientRect().top;
      const anchor = Array.from(rows.children).find((row) => (
        row instanceof HTMLElement && row.getBoundingClientRect().bottom > top
      ));
      const before = anchor?.getBoundingClientRect().top ?? 0;
      change();
      if (!(anchor instanceof HTMLElement) || !anchor.isConnected) return;
      const drift = anchor.getBoundingClientRect().top - before;
      if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift;
    };

    // A row outside the viewport whose height is wrong moves the rows under it, so the
    // size is read in one pass and written in the next: reading a box after writing a
    // style would cost a layout per row instead of one for the batch.
    const skip = (targets: HTMLElement[]) => {
      const sized: { row: HTMLElement; size: number }[] = [];
      for (const row of targets) {
        // The last row has nothing under it to keep in place and is the newest content,
        // where the reader is, so it is never folded.
        if (!row.nextElementSibling) continue;
        const style = getComputedStyle(row);
        const around = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
        const outside = around.reduce((sum, edge) => sum + (parseFloat(style[edge]) || 0), 0);
        // `contain-intrinsic-block-size` sizes the content box, so what the row adds
        // around its content comes off the box. Left in, a padded row grows by its own
        // padding when folded (the load-earlier line, 21 px over by its 10.5 px above
        // and below).
        const size = Math.max(0, Math.round((row.getBoundingClientRect().height - outside) * 100) / 100);
        sized.push({ row, size });
      }
      for (const { row, size } of sized) {
        row.style.containIntrinsicBlockSize = `${size}px`;
        row.style.contentVisibility = "auto";
        skipped.add(row);
      }
    };

    const intersection = new IntersectionObserver((entries) => {
      const far: HTMLElement[] = [];
      holdWhile(() => {
        for (const entry of entries) {
          const row = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            near.add(row);
            if (skipped.has(row)) unskip(row);
          } else {
            near.delete(row);
            if (!skipped.has(row) && row.parentElement === rows) far.push(row);
          }
        }
        if (far.length > 0) skip(far);
      });
    }, { root: scroller, rootMargin: NEAR_MARGIN });

    const observe = (node: Node) => {
      if (node instanceof HTMLElement) intersection.observe(node);
    };
    const forget = (node: Node) => {
      if (!(node instanceof HTMLElement) || node.parentElement === rows) return;
      intersection.unobserve(node);
      near.delete(node);
      if (skipped.has(node)) unskip(node);
    };
    Array.from(rows.children).forEach(observe);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach(forget);
        record.addedNodes.forEach(observe);
      }
    });
    mutations.observe(rows, { childList: true });

    // A skipped row keeps its height from the old width, where its text wrapped
    // differently: once the width settles, measure them all again.
    let width = rows.getBoundingClientRect().width;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const resize = new ResizeObserver(() => {
      const next = rows.getBoundingClientRect().width;
      if (next === width) return;
      width = next;
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        const stale = Array.from(skipped);
        if (stale.length === 0) return;
        holdWhile(() => {
          stale.forEach(unskip);
          skip(stale.filter((row) => row.parentElement === rows && !near.has(row)));
        });
      }, RESIZE_SETTLE_MS);
    });
    resize.observe(rows);

    return () => {
      if (rowsRef) rowsRef.current = null;
      if (settle) clearTimeout(settle);
      intersection.disconnect();
      mutations.disconnect();
      resize.disconnect();
      skipped.forEach(unskip);
    };
  }, [rowsRef]);
}
