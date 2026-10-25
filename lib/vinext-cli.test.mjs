import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { findVinextCli } = require("../bin/vinext-cli.cjs");

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-vinext-cli-"));
}

function writeCli(pkgDir) {
  const cli = path.join(pkgDir, "node_modules", "vinext", "dist", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "export {};\n");
  return cli;
}

test("finds a hoisted vinext CLI in the package directory", () => {
  const pkgDir = makeTree();
  const cli = writeCli(pkgDir);

  assert.equal(findVinextCli(pkgDir), cli);
});

test("walks up from a nested package to the CLI above it", () => {
  const pkgDir = makeTree();
  const cli = writeCli(pkgDir);
  const nested = path.join(pkgDir, "node_modules", "@scope", "some-package");

  assert.equal(findVinextCli(nested), cli);
});

test("returns null when no ancestor has vinext installed", () => {
  const pkgDir = makeTree();
  fs.mkdirSync(path.join(pkgDir, "sub"), { recursive: true });

  assert.equal(findVinextCli(path.join(pkgDir, "sub")), null);
});
