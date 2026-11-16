import assert from "node:assert/strict";
import test from "node:test";

import {
  VISIBLE_PAGE_SIZE,
  captureScrollDistance,
  getNextVisibleCount,
  nextRequestedCursor,
  nextVisibleCountForHead,
  olderPageRequest,
} from "../lib/chat-lazy-load.ts";

// The sentinel at the top of the message list asks for the older page when it comes into
// view, and the window grows by the page that landed above it — never to the whole
// loaded history, which kept every row mounted and layout went with it.

/** What the sentinel coming into view asks for. */
function reachTop(input) {
  return olderPageRequest({
    pendingScrollRestore: null,
    loadingOlder: false,
    hasEarlierMessages: true,
    historyCursor: "older",
    requestedCursor: null,
    sessionId: "a",
    ...input,
  });
}

test("a reading position that has not landed yet outranks the sentinel", async () => {
  // The restore fetches its own pages, so a page fetched here would be prepended with
  // this callback's own distance-from-bottom restore and shove the viewport back to the
  // top of what is loaded — where the sentinel still shows and it asks again.
  for (const hasEarlierMessages of [true, false]) {
    assert.deepEqual(reachTop({ pendingScrollRestore: { anchorEntryId: "e1" }, hasEarlierMessages }), { kind: "none" });
  }
});

test("with every message loaded, reaching the top widens the window over rows still hidden", async () => {
  // The messages render as more rows than the window holds (an answer and its thinking
  // are two), so the sentinel shows while rows are still hidden: the window grows.
  assert.deepEqual(reachTop({ hasEarlierMessages: false }), { kind: "widen" });
  assert.equal(getNextVisibleCount(50), 100);
  assert.equal(captureScrollDistance(4000, 0), 4000, "the distance is captured to restore the viewport after the widen");
});

test("with older history on the server, reaching the top fetches the previous page", async () => {
  assert.deepEqual(reachTop({}), { kind: "fetch", sessionId: "a", before: "older" });
});

test("a report before the next cursor renders does not fetch the landed page again", async () => {
  const requested = nextRequestedCursor({ before: "older", landed: {}, requestedCursor: "older" });
  assert.deepEqual(reachTop({ requestedCursor: requested }), { kind: "none" });
  // The next cursor renders, so the page it names may be asked for.
  assert.deepEqual(nextRequestedCursor({ before: "oldest", landed: {}, requestedCursor: "oldest" }), "oldest");
  assert.deepEqual(reachTop({ historyCursor: "oldest", requestedCursor: "oldest" }), { kind: "none" });
});

test("a page that did not land is asked for again, and a cursor set meanwhile stands", async () => {
  // Nothing landed, so the same page may be asked for again.
  assert.equal(nextRequestedCursor({ before: "older", landed: undefined, requestedCursor: "older" }), null);
  assert.deepEqual(reachTop({ requestedCursor: null }), { kind: "fetch", sessionId: "a", before: "older" });
  // Another call moved the cursor on while this page was in flight: its own stands.
  assert.equal(nextRequestedCursor({ before: "older", landed: {}, requestedCursor: "newest" }), "newest");
});

test("a page already loading is not asked for twice", async () => {
  assert.deepEqual(reachTop({ loadingOlder: true }), { kind: "none" });
});

test("a session that has no id yet is not asked for a page", async () => {
  assert.deepEqual(reachTop({ sessionId: null }), { kind: "none" });
});

/** The window after one history landed: `render(ids, length)` is the next one. */
function windowState({ visibleCount = 50 } = {}) {
  let previousHead = null;
  let previousLength = 0;
  return {
    render: (ids, length) => {
      const head = `${ids[0] ?? ""}|${ids[0] ?? ""}`;
      const next = nextVisibleCountForHead({
        previousHead, head, previousLength, length, currentVisibleCount: visibleCount, pageSize: VISIBLE_PAGE_SIZE,
      });
      previousHead = head;
      previousLength = length;
      visibleCount = next;
      return next;
    },
  };
}

test("the first page fills the window without widening it", () => {
  const chat = windowState();
  const ids = Array.from({ length: 50 }, (_, index) => `e${index}`);
  assert.equal(chat.render(ids, ids.length), 50);
});

test("a page prepended above the window widens it by that page", () => {
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index + 20}`);
  chat.render(loaded, loaded.length);

  const older = Array.from({ length: 20 }, (_, index) => `e${index}`);
  assert.equal(chat.render([...older, ...loaded], 70), 100);
});

test("a run's own messages leave the window alone", () => {
  // The window ends at the tail, so an appended turn is inside it already.
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index}`);
  chat.render(loaded, loaded.length);

  assert.equal(chat.render(loaded, 53), 50);
});

test("a shorter history leaves the window alone", () => {
  // A branch switch loads fewer messages; widening would keep rows of the old
  // branch mounted.
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index}`);
  chat.render(loaded, loaded.length);

  const branch = Array.from({ length: 12 }, (_, index) => `b${index}`);
  assert.equal(chat.render(branch, branch.length), 50);
});
