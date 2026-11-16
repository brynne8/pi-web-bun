import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true, tryNative: false });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TopBarRightGroup } = await jiti.import("./TopBarRightGroup.tsx");

// The top bar's right-hand group: the row's push-right anchor sits on the group's own
// element, never on a button inside it that may not render.
const shell = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const group = (html) => html.slice(html.indexOf("<div data-top-bar-group=\"right\""), html.indexOf("</div>", html.indexOf("<div data-top-bar-group=\"right\"")));
const render = (children) => renderToStaticMarkup(React.createElement(TopBarRightGroup, null, children));

test("the top bar's right-hand group carries its own anchor", () => {
  const html = render("children");
  assert.match(html, /data-top-bar-group="right"/);
  assert.match(group(html), /margin-left:auto/);
  assert.match(group(html), /align-items:center/);
});

test("the anchor does not ride a button that may not render", () => {
  // The anchor lives on the group's element alone, so no button of the row can carry it.
  assert.doesNotMatch(shell, /marginLeft: "auto"/, "the row's anchor belongs to TopBarRightGroup");
  // An empty group still anchors the row, without a button of its own.
  const empty = render();
  assert.equal((empty.match(/margin-left:auto/g) ?? []).length, 1);
  assert.doesNotMatch(empty, /<button/);
});

test("the row's two buttons sit in the group, after the chat's own actions", () => {
  assert.match(
    shell,
    /renderChatToolbarActions\(false\)\}[\s\S]*?<TopBarRightGroup>[\s\S]*?renderSessionStatsButton\(false\)[\s\S]*?renderMainFileToggle\(false\)[\s\S]*?<\/TopBarRightGroup>/,
    "the group holds the session stats and the file-panel button, after the chat's actions",
  );
  const groupStart = shell.indexOf("<TopBarRightGroup>");
  assert.ok(shell.slice(0, groupStart).includes("renderProjectTrustWarning(false)"), "the trust warning stays before the group");
  assert.ok(!shell.slice(groupStart, shell.indexOf("</TopBarRightGroup>")).includes("renderChatToolbarActions"), "the chat's actions stay outside the group");
});

test("the group holds whatever the row puts in it", () => {
  const html = render([
    React.createElement("button", { type: "button", key: "stats" }, "stats"),
    React.createElement("button", { type: "button", key: "files" }, "files"),
  ]);
  assert.match(html, /<button[^>]*>stats<\/button>/);
  assert.match(html, /<button[^>]*>files<\/button>/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});
