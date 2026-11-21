import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The client graph's own syntax rule, checked once: Vite compiles for `build.target:
 * "safari16.2"`, which lowers class fields and the rest, but a RegExp lookbehind it cannot
 * downlevel — Safari parses one only from 16.4, and a lookbehind there is a blank page
 * (AGENTS.md, "Old Safari (iOS 16.2)").
 *
 * A per-component copy of this scan lived in five files, one per component that grew one; the
 * rule is the repository's, so it is read off every client file here instead.
 */

const ROOTS = ["components", "hooks"];
/** Client-safe lib modules: no node imports, read by a component or a hook. */
const CLIENT_LIB = ["lib/session-ui-state-shared.ts"];
const LOOKBEHIND = /\(\?<[=!]/;

function clientFiles() {
  const files = [];
  for (const root of ROOTS) walk(root, files);
  return files;
}

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
      continue;
    }
    // A test reads sources; it is not one of them.
    if (!/\.(ts|tsx)$/.test(entry.name) || entry.name.endsWith(".test.mjs")) continue;
    files.push(path);
  }
}

test("no file in the client graph carries a RegExp lookbehind", () => {
  const offenders = [...clientFiles(), ...CLIENT_LIB]
    .filter((path) => LOOKBEHIND.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, [], "Safari 16.2 has no lookbehind: a page with one is blank");
});
