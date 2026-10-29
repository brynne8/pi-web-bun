import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

const { captureScrollDistance, getNextVisibleCount, VISIBLE_PAGE_SIZE } = await import("../lib/chat-lazy-load.ts");

const source = ts.createSourceFile("ChatWindow.tsx", await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const hook = (name, includes) => nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === name
  && node.arguments[0].getText(source).includes(includes));
const compile = (node) => new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
const effect = hook("useEffect", "new IntersectionObserver");
assert.ok(effect, "missing the sentinel observer effect");
const [body] = effect.arguments;
const script = compile(body);
const loadOlderPage = compile(hook("useCallback", "requestedCursorRef.current = before").arguments[0]);
const forgetCursor = compile(hook("useEffect", "requestedCursorRef.current = null").arguments[0]);
// The window is bounded: it grows by the page that landed above it, never to the
// whole loaded history.
const widenForPage = compile(hook("useEffect", "historyHeadRef.current = head").arguments[0]);

// Mounts the observer effect with the given history state; `reachTop()` is the
// sentinel coming into view, `render(cursor)` the next cursor rendering.
// `restoring: true` is a session re-opened where the reader had been, whose
// position has not landed yet (`pendingScrollRestore`).
function mount({ hasEarlierMessages, landed = true, restoring = false }) {
  const calls = { visibleCount: 50, loads: [] };
  let observed = null;
  const context = createContext({
    sentinel: {}, scrollContainerRef: { current: { scrollHeight: 4000, scrollTop: 0 } },
    loadingOlderRef: { current: false }, prevScrollDistanceRef: { current: null }, requestedCursorRef: { current: null },
    pendingScrollRestoreRef: { current: restoring ? { anchorEntryId: "e1", anchorOffset: 120 } : null },
    hasEarlierMessages, historyCursor: "older", session: { id: "a" }, sessionIdRef: { current: "a" }, activeLeafId: "leaf",
    captureScrollDistance, getNextVisibleCount,
    setVisibleCount: (update) => { calls.visibleCount = update(calls.visibleCount); },
    loadContext: (...args) => { calls.loads.push(args); return Promise.resolve(landed ? { oldestEntryId: "oldest" } : undefined); },
    IntersectionObserver: class { constructor(callback) { observed = callback; } observe() {} disconnect() {} },
  });
  context.loadOlderPage = loadOlderPage.runInContext(context);
  const run = () => script.runInContext(context)();
  run();
  return {
    calls,
    context,
    reachTop: async () => {
      observed([{ isIntersecting: true }]);
      await new Promise((resolve) => setImmediate(resolve));
    },
    render: (cursor) => {
      context.historyCursor = cursor;
      forgetCursor.runInContext(context)();
      run();
    },
  };
}

async function reachTop(state) {
  const { calls, context, reachTop: report } = mount(state);
  await report();
  return { ...calls, scrollDistance: context.prevScrollDistanceRef.current };
}

// Runs the window effect against one loaded history: `render(ids, length)` is
// the next history that landed.
function windowState({ visibleCount = 50 } = {}) {
  const calls = { visibleCount };
  const context = createContext({
    messageKeys: [], entryIds: [], messages: { length: 0 },
    historyHeadRef: { current: null }, previousLengthRef: { current: 0 },
    VISIBLE_PAGE_SIZE,
    setVisibleCount: (update) => { calls.visibleCount = update(calls.visibleCount); },
  });
  return {
    calls,
    render: (ids, length) => {
      context.messageKeys = ids;
      context.entryIds = ids;
      context.messages = { length };
      widenForPage.runInContext(context)();
      return calls.visibleCount;
    },
  };
}

const cursors = (calls) => calls.loads.map((args) => args[2]);

test("a reading position that has not landed yet outranks the sentinel", async () => {
  // The restore fetches its own pages, so a page fetched here would be prepended with
  // this callback's own distance-from-bottom restore and shove the viewport back to the
  // top of what is loaded — where the sentinel still shows and it asks again.
  for (const hasEarlierMessages of [true, false]) {
    const { calls, context, reachTop } = mount({ hasEarlierMessages, restoring: true });
    await reachTop();
    assert.deepEqual(cursors(calls), [], `no page is fetched while a restore is pending (older history ${hasEarlierMessages ? "on the server" : "fully loaded"})`);
    assert.equal(calls.visibleCount, 50, "the window is not widened either");
    assert.equal(context.prevScrollDistanceRef.current, null, "and no distance is captured that would later restore the viewport to the top");
  }
});

test("with every message loaded, reaching the top widens the window over rows still hidden", async () => {
  assert.deepEqual(await reachTop({ hasEarlierMessages: false }), { visibleCount: 100, loads: [], scrollDistance: 4000 });
});

test("with older history on the server, reaching the top fetches the previous page", async () => {
  const { visibleCount, loads } = await reachTop({ hasEarlierMessages: true });
  assert.equal(visibleCount, 50);
  assert.deepEqual(loads.map((args) => [...args]), [["a", "leaf", "older", undefined]]);
});

test("a report before the next cursor renders does not fetch the landed page again", async () => {
  const chat = mount({ hasEarlierMessages: true });
  await chat.reachTop();
  await chat.reachTop();
  assert.deepEqual(cursors(chat.calls), ["older"]);
  chat.render("oldest");
  await chat.reachTop();
  assert.deepEqual(cursors(chat.calls), ["older", "oldest"]);
});

test("a page that did not land, or a cursor a reload brought back, is fetched again", async () => {
  const failed = mount({ hasEarlierMessages: true, landed: false });
  await failed.reachTop();
  await failed.reachTop();
  assert.deepEqual(cursors(failed.calls), ["older", "older"]);

  const reloaded = mount({ hasEarlierMessages: true });
  await reloaded.reachTop();
  reloaded.render("oldest");
  reloaded.render("older");
  await reloaded.reachTop();
  assert.deepEqual(cursors(reloaded.calls), ["older", "older"]);
});

test("the window stays bounded by what the reader asked for", async () => {
  // Every loaded message used to stay mounted: the window was raised to the
  // whole history as soon as it landed, so a long session kept every row in the
  // DOM and layout went with it.
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    chatSource,
    /useEffect\(\(\) => \{\s*setVisibleCount\(\(current\) => Math\.max\(current, messages\.length\)\)/,
    "no effect raises the window to the whole loaded history",
  );
});

test("the first page fills the window without widening it", async () => {
  const chat = windowState();
  const ids = Array.from({ length: 50 }, (_, index) => `e${index}`);
  assert.equal(chat.render(ids, ids.length), 50);
});

test("a page prepended above the window widens it by that page", async () => {
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index + 20}`);
  chat.render(loaded, loaded.length);

  const older = Array.from({ length: 20 }, (_, index) => `e${index}`);
  assert.equal(chat.render([...older, ...loaded], 70), 100);
});

test("a run's own messages leave the window alone", async () => {
  // The window ends at the tail, so an appended turn is inside it already.
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index}`);
  chat.render(loaded, loaded.length);

  assert.equal(chat.render(loaded, 53), 50);
});

test("a shorter history leaves the window alone", async () => {
  // A branch switch loads fewer messages; widening would keep rows of the old
  // branch mounted.
  const chat = windowState();
  const loaded = Array.from({ length: 50 }, (_, index) => `e${index}`);
  chat.render(loaded, loaded.length);

  const branch = Array.from({ length: 12 }, (_, index) => `b${index}`);
  assert.equal(chat.render(branch, branch.length), 50);
});
