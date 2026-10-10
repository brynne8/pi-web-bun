import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const messageSource = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("groups the leading segment when the history page starts mid-turn", () => {
  // A turn longer than the initial page loses its anchor, and the old loop
  // flattened every message before the first anchor instead of grouping them.
  assert.match(source, /const hasAnchor = isMessageGroupAnchor\(msg\)/);
  assert.match(source, /if \(!hasAnchor && idx !== 0\)/);
  assert.match(source, /const userIdx = hasAnchor \? idx : -1/);
  assert.match(source, /const groupStartIdx = hasAnchor \? idx : 0/);
  assert.match(source, /if \(hasAnchor\) rendered\.push\(renderMessage\(userIdx\)\)/);
});

test("renders a turn as its segments, so nothing the model wrote is filed away", () => {
  // One fold per run of thinking and tool calls, with the text between them
  // rendered in place: the turn's words used to sit inside the group.
  assert.match(source, /const segments = splitTurnSegments\(messages, userIdx \+ 1, endIdx\)/);
  assert.match(source, /for \(const \[segmentIdx, segment\] of segments\.entries\(\)\)/);
  assert.match(source, /if \(segment\.kind === "process"\) \{/);
  assert.match(source, /rendered\.push\(\.\.\.views\)/, "an answer segment renders directly");
  assert.match(source, /key=\{`process-group-\$\{entryIds\[groupStartIdx\] \?\? groupStartIdx\}-\$\{segmentIdx\}`\}/);
});

test("a group starts collapsed even when the turn wrote nothing", () => {
  // Thinking and tool calls are the workings whatever else the turn produced, so
  // they fold the same way. What used to open the last group was the worry that a
  // turn whose only content is a failure would show nothing at all — that failure
  // now renders below the group, so nothing is hidden by the fold (#906).
  assert.doesNotMatch(source, /defaultExpanded/);
  assert.match(source, /const \[expanded, setExpanded\] = useState\(false\)/);
});

test("a turn's failure renders below the fold, not inside it", () => {
  // pi records the provider error or the output limit on the response that ended
  // the run, which sits inside the last group. Collapsing that group would hide the
  // one thing the user needs to read, so ChatWindow pulls the notice out to the
  // turn's end, where the footer already is (#906).
  assert.match(source, /let noticeMessage: AssistantMessage \| undefined;/);
  assert.match(source, /<AssistantNotice/);
  assert.match(source, /key=\{`turn-notice-\$\{entryIds\[groupStartIdx\] \?\? groupStartIdx\}`\}/);
  // Only a run the output limit cut off, with no answer anywhere in the turn and the
  // session's tail still where it stopped, offers to compact.
  assert.match(source, /const canRecover = !answered && isAssistantTruncated\(notice\) && !hasAssistantAnswer\(notice\)/);
  assert.match(source, /&& endIdx === messages\.length && !streamState\.isStreaming;/);
  // A part never renders the notice itself, or it would print inside the group as well.
  assert.match(messageSource, /\{!isTurnPart && \(providerError \|\| truncated\) && \(/);
});

test("a running turn prints no token counts under its parts", () => {
  // While the run was going, each stored entry printed its own "… in · … out" row,
  // and every one of them vanished the moment the run ended and folded. The numbers
  // describe the turn, so they come with the turn's footer and not before it exists.
  assert.match(source, /rendered\.push\(renderMessage\(renderIdx, \{ isTurnPart: true \}\)\)/);
  assert.doesNotMatch(source, /renderMessage\(renderIdx\)/);
});

test("a group keeps its open or closed state across a turn's updates", () => {
  // Nothing about a group's default depends on the turn's answer any more, so
  // re-keying it would close a group the user had opened by hand on every update.
  assert.match(source, /<ProcessDetailsGroup\s+messageCount=/);
});

test("keeps a part's blocks under the indices they were stored at", () => {
  // A turn renders as slices of stored messages, and deferred thinking is loaded
  // by its stored index: a slice that reported its own offsets would fetch the
  // wrong block.
  assert.match(source, /blockIndexOffset: part\.start/);
  assert.match(messageSource, /originalIndex: index \+ \(blockIndexOffset \?\? 0\)/);
});

test("passes a grouped turn's MessageViews the same copies on every render (#1005)", () => {
  // Fresh copies per render re-ran every visible part's markdown on each chat
  // update, e.g. on every key typed into an extension's custom panel.
  assert.doesNotMatch(source, /withAssistantBlocks\(/);
  assert.match(source, /const turnPartCache = useMemo<TurnPartCache>\(\(\) => new WeakMap\(\), \[\]\)/);
  // The file list and the numbers are the turn's, computed once per turn: the
  // footer is one element at the turn's end, not a prop on each part, so there is
  // nothing left whose identity has to be kept across renders.
  assert.doesNotMatch(source, /turnWrittenFilesCache|keepTurnWrittenFiles/);
  assert.match(source, /getTurnPart\(turnPartCache, stored, part\.start, part\.end\)/);
});

test("a group's contents are not the turn's scroll target", () => {
  // The minimap and the jump-to-message refs belong on the answer; a collapsed
  // group holds the workings, which the user cannot see at that moment.
  assert.match(source, /attachRef: segment\.kind === "answer"/);
});

test("skips custom messages without display and counts them nowhere (#1043)", () => {
  // pi's TUI never renders them; one card per idle session restart flooded the chat.
  assert.match(source, /const msg = options\.messageOverride \?\? messages\[idx\];\s*if \(isHiddenCustomMessage\(msg\)\) return null;/);
});

test("a turn's footer is the turn's, rendered once where the turn ends", () => {
  // Copy, the changed-file list and the token counts belong to the turn. Attached to
  // a part they repeated — pi-web saves one assistant entry per tool call — and they
  // landed under a sentence in the middle whenever the turn ended on thinking or a
  // tool call, as it does when the user stops a run mid-thinking. So no part shows
  // them, and `TurnFooter` renders after the last segment.
  assert.match(source, /isTurnPart: true,/);
  assert.doesNotMatch(source, /carriesTurnFooter/);
  assert.doesNotMatch(source, /turnCopyText:/);
  assert.match(source, /<TurnFooter/);
  assert.match(source, /key=\{`turn-footer-\$\{entryIds\[groupStartIdx\] \?\? groupStartIdx\}`\}/);
  // The numbers are the last response's: what the final message used to show.
  assert.match(source, /if \(turnMessage\.usage && recordsUsage\(turnMessage\.usage\)\) turnUsage = turnMessage\.usage;/);
  assert.match(messageSource, /const showsTurnFooter = !isTurnPart;/);
  assert.match(messageSource, /\{showsTurnFooter && message\.usage && !isStreaming && \(/);
  assert.match(messageSource, /\{textContent && showsTurnFooter && !isStreaming && \(/);
});

test("the turn's time is the turn's too, not one stamp walking down its parts", () => {
  // While the run went on, the entry that had just finished showed a timestamp and
  // lost it as soon as the next entry arrived: a clock ticking down the turn, then
  // nothing once it folded. The footer carries the one time that means something.
  assert.match(source, /turnTimestamp = turnMessage\.timestamp \?\? turnTimestamp;/);
  assert.match(source, /timestamp=\{turnTimestamp\}/);
  // So nothing has to pick which part gets the time any more.
  assert.doesNotMatch(source, /showTimestamp:/);
  assert.match(messageSource, /const time = showTimestamp && !isTurnPart \? formatTime\(message\.timestamp\) : null;/);
});

test("a process group sits in the same vertical rhythm as a message", () => {
  // The group carried 14 against the message's 16, and collapsed it holds only its
  // own button, so no child margin reaches through to even it out: the gap above it
  // read larger than the one below, like a stray blank line.
  assert.match(source, /<div style=\{\{ marginBottom: 16 \}\}>/);
  assert.match(messageSource, /marginBottom: 16 }}\n\s+onMouseEnter/);
});

test("the memoized MessageView notices a part that gained or lost the turn", () => {
  // A turn's parts are cached copies: a message copy is the same object whether or
  // not it belongs to a segmented turn, so a comparator that ignores these props
  // keeps the footer painted, or missing, from the previous layout.
  assert.match(messageSource, /&& prev\.blockIndexOffset === next\.blockIndexOffset/);
  assert.match(messageSource, /&& prev\.isTurnPart === next\.isTurnPart/);
});
