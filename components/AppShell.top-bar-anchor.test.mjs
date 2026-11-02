import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile("AppShell.tsx", await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);

function functionSource(name) {
  const decl = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(decl, `${name} must exist`);
  return decl.initializer.getText(source);
}

function opening(node) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function rightGroup() {
  const group = nodes.filter(ts.isJsxElement).find((node) => opening(node).attributes.properties
    .filter(ts.isJsxAttribute)
    .some((attr) => attr.name.getText(source) === "data-top-bar-group" && attr.initializer?.getText(source) === '"right"'));
  assert.ok(group, 'the desktop right-hand group needs its own element (data-top-bar-group="right")');
  return group;
}

function styleProperty(element, name) {
  const style = opening(element).attributes.properties.filter(ts.isJsxAttribute)
    .find((attr) => attr.name.getText(source) === "style");
  const object = style?.initializer && ts.isJsxExpression(style.initializer) && ts.isObjectLiteralExpression(style.initializer.expression)
    ? style.initializer.expression
    : null;
  assert.ok(object, `the element needs a style object with ${name}`);
  const prop = object.properties.filter(ts.isPropertyAssignment).find((p) => p.name.getText(source) === name);
  return prop?.initializer.getText(source) ?? null;
}

test("the top bar's right-hand group carries its own anchor", () => {
  assert.equal(styleProperty(rightGroup(), "marginLeft"), '"auto"');
});

test("the anchor does not ride a button that may not render", () => {
  for (const name of ["renderSessionStatsButton", "renderMainFileToggle"]) {
    assert.ok(!functionSource(name).includes("marginLeft"), `${name} must not carry the row's marginLeft anchor`);
  }
});

test("the group holds the session stats and the file-panel button", () => {
  const calls = rightGroup().children.map((child) => child.getText(source)).join("");

  for (const call of ["renderSessionStatsButton(false)", "renderMainFileToggle(false)"]) {
    assert.ok(calls.includes(call), `the group must hold ${call}`);
  }
});

test("the chat's own actions stay at the bar's left of the group", () => {
  const group = rightGroup();
  const calls = group.children.map((child) => child.getText(source)).join("");
  for (const call of ["renderChatToolbarActions(false)", "renderProjectTrustWarning(false)"]) {
    assert.ok(!calls.includes(call), `${call} belongs before the group, not in it`);
  }
  const before = source.getText().slice(0, group.getStart(source));
  assert.ok(before.includes("renderChatToolbarActions(false)"), "the chat's actions render ahead of the group in the row");
});
