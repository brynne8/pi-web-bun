import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true, tryNative: false });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TopBarRightGroup } = await jiti.import("./TopBarRightGroup.tsx");

// The top bar's right-hand group: the row's push-right anchor sits on the group's own
// element, never on a button inside it that may not render.

const group = (html) => html.slice(html.indexOf("<div data-top-bar-group=\"right\""), html.indexOf("</div>", html.indexOf("<div data-top-bar-group=\"right\"")));

test("the top bar's right-hand group carries its own anchor", () => {
  const html = renderToStaticMarkup(React.createElement(TopBarRightGroup, null, "children"));
  assert.match(html, /data-top-bar-group="right"/);
  assert.match(group(html), /margin-left:auto/);
  assert.match(group(html), /align-items:center/);
});

test("the anchor does not ride a button that may not render", () => {
  // The group renders its children, so a button inside it is never the anchor itself.
  const empty = renderToStaticMarkup(React.createElement(TopBarRightGroup, null));
  assert.match(empty, /margin-left:auto/, "an empty group still anchors the row");
  assert.doesNotMatch(empty, /<button/);
});

test("the group holds whatever the row puts in it", () => {
  const html = renderToStaticMarkup(React.createElement(TopBarRightGroup, null,
    React.createElement("button", { type: "button" }, "stats"),
    React.createElement("button", { type: "button" }, "files"),
  ));
  assert.match(html, /<button[^>]*>stats<\/button>/);
  assert.match(html, /<button[^>]*>files<\/button>/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});
