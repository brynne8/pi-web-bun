import assert from "node:assert/strict";

/**
 * Rows far off screen skip their layout, held by a placeholder of the room they take
 * in the flow. A placeholder that is not that room moves the rows under it: the
 * transcript the reader is in jumps up and down while they scroll
 * (hooks/useSkipOffscreenRows.ts). So park in the middle of a long session, roll the
 * fold boundary over the rows around the parked one and come back to it, and require
 * the screen to be the screen it was: the same rows in view, in the same order.
 *
 * The scroll offset is not what is asserted. A placeholder can be off by the margin two
 * neighbouring rows share as one gap, and the reader's screen is then kept still while
 * the document's height is corrected outside the viewport. Which rows are in front of
 * the reader is the property; the offset in a 15000px document is means to it.
 */
export async function checkFoldingRowsLeavesTheViewStill(page) {
  const fold = await page.evaluate(async () => {
    const settled = () => new Promise((resolve) => setTimeout(resolve, 1200));
    const first = document.querySelector("[data-entry-id]");
    const rows = first?.parentElement;
    const scroller = (() => {
      for (let el = rows?.parentElement ?? null; el; el = el.parentElement) {
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "auto" || overflow === "scroll") return el;
      }
      return null;
    })();
    if (!rows || !scroller || !CSS.supports("content-visibility", "auto")) {
      return { supported: false, rows: 0, folded: 0, parked: null, moved: [] };
    }
    const name = (el) => el.dataset.entryId || "text:" + (el.textContent || "").replace(/\s+/g, " ").slice(0, 40);
    const read = () => {
      const box = scroller.getBoundingClientRect();
      const list = Array.from(rows.children);
      // The row the reader's scroll position is kept by: the one at the top of the
      // viewport, which the hook puts back after every batch it folds.
      const top = list.find((el) => el.getBoundingClientRect().bottom > box.top);
      // The rows in the strip the reader is looking at, not the ones a few pixels of
      // scroll offset would add or take away at the viewport's edge.
      const strip = { top: box.top + box.height * 0.25, bottom: box.top + box.height * 0.75 };
      const inStrip = list
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.bottom > strip.top && rect.top < strip.bottom;
        })
        .map((el) => name(el));
      return { scrollTop: scroller.scrollTop, top: top ? name(top) : null, inStrip };
    };

    // Park where rows fold on both sides of the screen: folding above the viewport
    // moves what is under it, and folding below moves the scroll height.
    scroller.scrollTop = Math.round(scroller.scrollHeight / 2);
    await settled();
    const parked = read();
    const moved = [];
    // Roll the boundary over the parked rows and back, several times: each crossing
    // folds rows away and brings them back, which is what a reader scrolling does.
    for (let round = 0; round < 6; round++) {
      scroller.scrollTop = parked.scrollTop + (round % 2 === 0 ? -260 : 260);
      await settled();
      scroller.scrollTop = parked.scrollTop;
      await settled();
      const now = read();
      if (now.top !== parked.top || now.inStrip.join() !== parked.inStrip.join()) {
        moved.push({ round, top: now.top, rowsInStrip: now.inStrip.length });
      }
    }
    const folded = Array.from(rows.children).filter((el) => el.style.contentVisibility === "auto").length;
    return { supported: true, rows: rows.children.length, folded, parked, moved };
  });

  assert.equal(fold.supported, true, "This check measures a fold the engine has to perform");
  assert.ok(fold.folded > 20, `Folding must be happening for this check to mean anything, saw ${fold.folded} folded rows of ${fold.rows}`);
  assert.deepEqual(fold.moved.slice(0, 3), [],
    `Coming back to a place in the transcript must show the screen it showed (of 6 returns, ${fold.moved.length} differed; parked at scrollTop ${fold.parked.scrollTop} on row ${fold.parked.top} with ${fold.parked.inStrip.length} rows in the strip)`);
}
