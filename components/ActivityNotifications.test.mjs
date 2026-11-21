import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true, tryNative: false });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { ActivityNotifications } = await jiti.import("./ActivityNotifications.tsx");

const h = React.createElement;
const NOW = 1_000_000;

/** What a reader sees: the text between tags, the stylesheet left out. */
function visibleText(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function row(overrides = {}) {
  return { kind: "bash", id: "bash-3f2a9b1c", title: "bun test", outcome: "completed", finishedAtMs: NOW - 12_000, entryId: "entry-1", ...overrides };
}

function render(notifications, opened = []) {
  return renderToStaticMarkup(h(I18nProvider, null,
    h(ActivityNotifications, { notifications, now: NOW, onOpenNotification: (entryId) => opened.push(entryId) })));
}

test("an empty section says nothing has finished", () => {
  const html = render([]);
  assert.match(visibleText(html), /^Notifications Nothing has finished in the background yet\.$/);
});

test("three results show at a glance, the rest behind one fold", () => {
  const rows = Array.from({ length: 5 }, (_, index) => row({ id: `bash-${index}`, title: `task ${index}`, finishedAtMs: NOW - (index + 1) * 1000 }));
  const html = render(rows);
  const text = visibleText(html);
  assert.match(text, /task 0/);
  assert.match(text, /task 2/);
  assert.doesNotMatch(text, /task 3/, "the fourth is folded away");
  assert.match(text, /2 more/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>2 more</, "the fold is a button");
});

test("a row says how it ended, how long ago, and opens its card", () => {
  const opened = [];
  const html = render([row({ outcome: "exited with code 1" })], opened);
  const text = visibleText(html);
  assert.match(text, /bun test/);
  assert.match(text, /12s ago/);
  const button = html.slice(html.indexOf("<button"));
  assert.match(button, /title="bun test&#x27;\n?|title="bun test/);
  assert.match(html, /Outcome: exited with code 1/);
  // The click the row carries is the entry id the rail scrolls to.
  const onClick = /onClick/.test(html);
  assert.equal(onClick, false, "a server render keeps its handlers off the markup");
  assert.deepEqual(opened, []);
});

test("a result still on its way is not a button: it says it is arriving", () => {
  const html = render([row({ entryId: undefined, outcome: "completed" })]);
  const text = visibleText(html);
  assert.match(text, /arriving/);
  assert.doesNotMatch(html, /<button/);
});

test("a subagent's result reads as one too, with its own glyph", () => {
  const html = render([row({ kind: "subagent", id: "child-session", title: "Inspect parser", outcome: "failed" })]);
  const text = visibleText(html);
  assert.match(text, /Inspect parser/);
  assert.match(html, /<svg[^>]*><rect/);
});
