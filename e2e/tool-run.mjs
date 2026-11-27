// A merged tool run has to read as a level. Its header counts the calls ("bash ×48"), and opening it
// shows them one step inside that header. Written flat, the calls share the header's left edge and
// the edge of every row around it, so an opened run reads as 48 more top-level rows rather than one
// header's calls — which is what this measures.
import assert from "node:assert/strict";

/** The run row's accessible name: the tool's name, the count, nothing else. */
const RUN_ROW = /^(?:bash|powershell|read|edit|write|grep|find|ls|codemode) ×\d+$/;

/** How far a run's own calls sit inside their header, as `ToolRunRow` writes it. */
const TOOL_RUN_INDENT_PX = 16;

/** A tool call and a merged run are drawn in the same card, and the stylesheet reaches both by that inline fill. */
const CARD_SELECTOR = "div[style*='rgba(34, 197, 94, 0.04)']";

/** Everything the page-side step needs; a page function sees no module binding, so all of it arrives as data. */
const args = {
  cardSelector: `.chat-content ${CARD_SELECTOR}`,
  pattern: RUN_ROW.source,
};

/**
 * One round, run in the page: open the turn's fold, open the run row inside it, bring the header to
 * the top so the calls below it render (rows off the viewport are placeholders with no content), then
 * report where every card starts. The run's calls are the cards starting right of the header, and the
 * run is over where a card starts on the header's own line again.
 */
const step = ({ cardSelector, pattern }) => {
  const all = [...document.querySelectorAll(cardSelector)];
  const header = all.find((card) => new RegExp(pattern).test(card.querySelector("button")?.getAttribute("aria-label") ?? ""));
  if (!header) {
    const fold = [...document.querySelectorAll(".chat-content button[aria-expanded='false']")]
      .find((b) => /tool calls/.test(b.getAttribute("aria-label") ?? ""));
    if (fold) fold.click();
    return { state: fold ? "opened the turn's fold" : "no run row yet" };
  }
  const button = header.querySelector("button");
  if (button.getAttribute("aria-expanded") === "false") {
    button.click();
    return { state: "opened the run row" };
  }
  header.scrollIntoView({ block: "start" });
  const following = all.slice(all.indexOf(header) + 1).map((card) => card.getBoundingClientRect());
  if (following.length < 2) return { state: "waiting for the run's rows" };
  const headerLeft = Math.round(header.getBoundingClientRect().left);
  const memberCount = following.findIndex((box) => Math.round(box.left) === headerLeft);
  const members = memberCount === -1 ? following : following.slice(0, memberCount);
  return {
    state: "measured",
    label: button.getAttribute("aria-label"),
    headerLeft,
    headerWidth: Math.round(header.getBoundingClientRect().width),
    rendered: following.length,
    members: members.length,
    memberLefts: [...new Set(members.map((box) => Math.round(box.left)))],
    memberWidths: [...new Set(members.map((box) => Math.round(box.width)))],
    outsideLefts: memberCount === -1 ? [] : [...new Set(following.slice(memberCount).map((box) => Math.round(box.left)))],
  };
};

/**
 * Open what hides the run, whatever a previous check left folded, then compare edges: the run's calls
 * all start on one line, that line sits `TOOL_RUN_INDENT_PX` right of the header's card, and the rows
 * the run ends with are back on the header's own line.
 */
export async function checkToolRunIndentation(page) {
  let result = { state: "starting" };
  for (let round = 0; round < 40 && result.state !== "measured"; round++) {
    result = await page.evaluate(step, args);
    // A click needs React's commit before the next round reads the same attribute; clicking the same
    // row twice would close it again.
    await page.waitForTimeout(result.state.startsWith("opened") ? 600 : 250);
  }
  assert.equal(result.state, "measured", `the run row is opened and its calls are rendered: ${JSON.stringify(result)}`);
  assert.ok(result.members >= 1,
    `an opened run's calls start inside its header, not on its edge: ${JSON.stringify(result)}`);
  assert.ok(result.members >= 2, `the run holds several calls: ${JSON.stringify(result)}`);
  assert.deepEqual(result.memberLefts, [result.headerLeft + TOOL_RUN_INDENT_PX],
    `the run's calls start one step inside its header: ${JSON.stringify(result)}`);
  assert.deepEqual(result.memberWidths, [result.headerWidth - TOOL_RUN_INDENT_PX],
    `the step in is the only difference between a call and its header: ${JSON.stringify(result)}`);
  assert.ok(result.outsideLefts.every((left) => left === result.headerLeft),
    `the rows after the run return to its edge: ${JSON.stringify(result)}`);
  console.log(`PASS: an expanded tool run indents its ${result.members} rendered calls inside the "${result.label}" header`);
}
