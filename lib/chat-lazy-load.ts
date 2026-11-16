export const VISIBLE_PAGE_SIZE = 50;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

/**
 * The first rendered entry to keep when the window holds `visibleCount` messages.
 *
 * The window counts messages, never rendered entries: one message can render as several entries
 * — a turn's words, each group of its workings, its footer — so slicing by entry count dropped
 * `entries - visibleCount` entries off the top even while every loaded message was inside the
 * window, and a prepended page lost its own first message from the DOM (sessions.md).
 */
export function getVisibleEntryStart<T extends { messageIdx: number }>(
  entries: readonly T[],
  messageCount: number,
  visibleCount: number,
): number {
  const startMessageIdx = Math.max(0, messageCount - Math.max(visibleCount, 0));
  const first = entries.findIndex((entry) => entry.messageIdx >= startMessageIdx);
  return first === -1 ? entries.length : first;
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

/**
 * The window a revealed entry needs: from the entry to the tail, plus one page
 * above it, so a reading position restored from a saved scroll anchor, a search
 * hit or a minimap jump lands with history above it rather than at the very top
 * of the window. An entry that is not loaded reveals everything that is.
 */
export function getAnchorRevealVisibleCount(entryCount: number, anchorIndex: number, pageSize = VISIBLE_PAGE_SIZE): number {
  const total = Math.max(entryCount, 0);
  if (anchorIndex < 0) return total;
  return Math.min(Math.max(total - anchorIndex + Math.max(pageSize, 0), 0), total);
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function shouldShowScrollToLatest(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  if (scrollHeight <= clientHeight) return false;
  return !isScrollAtTail(scrollTop, clientHeight, scrollHeight, tolerance);
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}

/**
 * What the sentinel coming into view asks for: the older page to fetch, or nothing,
 * because a reading position is still restoring, a page is already loading, that page
 * already landed, or there is no session to ask. `widen` means every message is loaded
 * and the window grows instead.
 */
export function olderPageRequest(input: {
  pendingScrollRestore: unknown;
  loadingOlder: boolean;
  hasEarlierMessages: boolean;
  historyCursor: string | null;
  requestedCursor: string | null;
  sessionId: string | null;
}): { kind: "none" } | { kind: "widen" } | { kind: "fetch"; sessionId: string; before: string } {
  // A reading position that has not landed yet outranks the sentinel. While a restore is
  // pending, every page this callback asks for is prepended with its own distance-from-
  // bottom restore, which holds the *bottom* of the content and therefore shoves the
  // viewport back to the top of everything loaded — and with the sentinel still in view,
  // it asks again, page after page. The restore fetches whatever pages it needs itself.
  if (input.pendingScrollRestore) return { kind: "none" };
  // Skip while a page is already loading.
  if (input.loadingOlder) return { kind: "none" };
  if (!input.hasEarlierMessages) {
    // Everything is loaded, yet the sentinel shows: the messages render as more rows
    // than the window holds (an answer and its thinking are two), so widen the window.
    // The observer is renewed with it, in case the sentinel stays in view.
    return { kind: "widen" };
  }
  // Its page already landed; the next cursor has not rendered yet.
  const oldestId = input.historyCursor;
  if (!oldestId || oldestId === input.requestedCursor) return { kind: "none" };
  if (!input.sessionId) return { kind: "none" };
  return { kind: "fetch", sessionId: input.sessionId, before: oldestId };
}

/**
 * The window after a page landed above it. A page prepended above the window widens it
 * by that page, so what the reader was looking at stays mounted and the scroll restore
 * has the same content to hold. Appends (a run's own messages) need nothing: the window
 * always ends at the tail, and a shorter history (a branch switch) leaves it alone.
 */
export function nextVisibleCountForHead(input: {
  previousHead: string | null;
  head: string;
  previousLength: number;
  length: number;
  currentVisibleCount: number;
  pageSize?: number;
}): number {
  const prepended = input.previousHead === null ? 0 : input.length - input.previousLength;
  if (input.previousHead === null || prepended <= 0 || input.previousHead === input.head) {
    return input.currentVisibleCount;
  }
  return input.currentVisibleCount + Math.max(input.pageSize ?? VISIBLE_PAGE_SIZE, prepended);
}

/**
 * The cursor of the page asked for last, kept until the next cursor renders. A page that
 * did not land may be asked for again; a cursor another call set meanwhile stands.
 */
export function nextRequestedCursor(input: {
  before: string;
  landed: unknown;
  requestedCursor: string | null;
}): string | null {
  if (input.requestedCursor !== input.before) return input.requestedCursor;
  return input.landed ? input.before : null;
}
