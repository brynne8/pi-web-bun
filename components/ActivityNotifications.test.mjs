import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true, tryNative: false });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ActivityNotifications } = await jiti.import("./ActivityNotifications.tsx");
const { RAIL_NOTIFICATION_LINGER_MS } = await jiti.import("@/lib/background-notifications");

const h = React.createElement;
const NOW = 1_000_000;
const LINGER_MS = RAIL_NOTIFICATION_LINGER_MS;

/** What a reader sees: the text between tags, the stylesheet left out. */
function visibleText(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function row(overrides = {}) {
  return {
    kind: "bash",
    id: "bash-3f2a9b1c",
    title: "bun test -- --runInBand",
    outcome: "completed",
    status: { state: "completed" },
    finishedAtMs: NOW - 12_000,
    consumed: false,
    deliveredAtMs: NOW - 12_000,
    entryId: "entry-1",
    ...overrides,
  };
}

function render(notifications, now = NOW) {
  return renderToStaticMarkup(h(I18nProvider, null,
    h(ActivityNotifications, { notifications, now, onOpenNotification: () => {} })));
}

test("an empty section says nothing has finished", () => {
  const html = render([]);
  assert.match(visibleText(html), /^Notifications Nothing has finished in the background yet\.$/);
});

test("three results show at a glance, the rest behind one fold", () => {
  const rows = Array.from({ length: 5 }, (_, index) => row({ id: `bash-${index}`, finishedAtMs: NOW - (index + 1) * 1000 }));
  const html = render(rows);
  const text = visibleText(html);
  assert.match(text, /bash-0/);
  assert.match(text, /bash-2/);
  assert.doesNotMatch(text, /bash-3/, "the fourth is folded away");
  assert.match(text, /2 more/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>2 more</, "the fold is a button");
});

test("a command reads as the id it answers to and that it finished, not as its own text", () => {
  const html = render([row({ outcome: "exited with code 1", status: { state: "exit", code: 1 } })]);
  const text = visibleText(html);
  assert.match(text, /bash-3f2a9b1c/);
  assert.match(text, /finished/, "a non-zero exit is a command that finished");
  assert.doesNotMatch(text, /exit code/, "the code is the command's own verdict, not this list's news");
  assert.doesNotMatch(text, /runInBand/, "the command stays in the card the row opens");
  // It is still there for whoever hovers: the row is an index, not a second copy.
  assert.match(html, /title="bun test -- --runInBand/);
});

test("a command that never finished says how it ended instead", () => {
  assert.match(visibleText(render([row({ outcome: "terminated by a signal", status: { state: "signal" } })])), /stopped by a signal/);
  assert.match(visibleText(render([row({ outcome: "aborted", status: { state: "stopped" } })])), /stopped/);
  assert.match(visibleText(render([row({ outcome: "failed (timed out)", status: { state: "failed", detail: "timed out" } })])), /failed/);
});

test("a row says whether the model has the result yet", () => {
  assert.match(visibleText(render([row({ entryId: undefined, consumed: false })])), /arriving/);
  assert.match(visibleText(render([row({ consumed: false })])), /delivered/);
  const taken = visibleText(render([row({ consumed: true, consumedAtMs: NOW - 1_000 })]));
  assert.match(taken, /taken/);
  assert.doesNotMatch(taken, /delivered|arriving/);
});

test("a result leaves a buffer after it reached the model, delivered or taken", () => {
  const delivered = [row({ deliveredAtMs: NOW - 1_000 })];
  assert.match(visibleText(render(delivered, NOW)), /bash-3f2a9b1c/, "still there just after it landed");
  assert.match(visibleText(render(delivered, NOW + LINGER_MS)), /Nothing has finished in the background yet\./, "gone once the buffer is up");
  const taken = [row({ consumed: true, consumedAtMs: NOW - 1_000, deliveredAtMs: NOW - 60_000 })];
  assert.match(visibleText(render(taken, NOW)), /taken/, "a taken row counts from the take, not the delivery");
  assert.match(visibleText(render(taken, NOW + LINGER_MS)), /Nothing has finished in the background yet\./);
  // A result still on its way has no clock at all.
  const arriving = [row({ entryId: undefined, deliveredAtMs: undefined })];
  assert.match(visibleText(render(arriving, NOW + 60 * 60_000)), /arriving/);
});

test("a result still on its way is not a button: it says it is arriving", () => {
  const html = render([row({ entryId: undefined })]);
  assert.match(visibleText(html), /arriving/);
  assert.doesNotMatch(html, /<button/);
});

test("a subagent's result reads as its own description, with its own glyph", () => {
  const html = render([row({ kind: "subagent", id: "child-session", title: "Inspect parser", outcome: "failed", status: { state: "failed" } })]);
  const text = visibleText(html);
  assert.match(text, /Inspect parser/);
  assert.match(text, /failed/);
  assert.match(html, /<svg[^>]*><rect/);
});
