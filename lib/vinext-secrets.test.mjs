import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { stripPrerenderSecret, getStripWarning, SERVER_MANIFEST } = require(
  "../bin/vinext-secrets.cjs",
);

const PUBLISHED_SECRET = "a6cb3eb43a40bc5906a7c3b6ea7bee61454ac753c56033ddf559119fd886923b";

function makeDistDir(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-strip-"));
  const serverDir = path.join(dir, "server");
  fs.mkdirSync(serverDir);
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(serverDir, SERVER_MANIFEST), JSON.stringify(manifest));
  }
  return dir;
}

function readManifest(distDir) {
  return JSON.parse(fs.readFileSync(path.join(distDir, "server", SERVER_MANIFEST), "utf8"));
}

test("removes the prerender secret and keeps the rest of the manifest", () => {
  const manifest = {
    version: 1,
    compress: true,
    prerenderSecret: PUBLISHED_SECRET,
    runtimeOutputDirs: ["dist/server"],
  };
  const distDir = makeDistDir(manifest);

  assert.deepEqual(stripPrerenderSecret(distDir), { ok: true, reason: "stripped" });

  const after = readManifest(distDir);
  assert.equal(Object.hasOwn(after, "prerenderSecret"), false);
  assert.equal(after.compress, true);
  assert.deepEqual(after.runtimeOutputDirs, manifest.runtimeOutputDirs);
  assert.deepEqual(fs.readdirSync(path.join(distDir, "server")), [SERVER_MANIFEST]);
});

test("is a no-op when the secret is already gone", () => {
  const distDir = makeDistDir({ compress: true });
  assert.deepEqual(stripPrerenderSecret(distDir), { ok: true, reason: "already-stripped" });
  assert.deepEqual(readManifest(distDir), { compress: true });
});

test("treats a missing manifest as safe, because there is no secret to leak", () => {
  const distDir = makeDistDir(undefined);
  assert.deepEqual(stripPrerenderSecret(distDir), { ok: true, reason: "missing" });
});

test("reports unreadable for malformed JSON", () => {
  const distDir = makeDistDir(undefined);
  fs.writeFileSync(path.join(distDir, "server", SERVER_MANIFEST), "{ not json");
  const result = stripPrerenderSecret(distDir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreadable");
});

test("reports unexpected-shape when the manifest is not an object", () => {
  const distDir = makeDistDir(null);
  assert.deepEqual(stripPrerenderSecret(distDir), { ok: false, reason: "unexpected-shape" });
});

test("reports unwritable and leaves the manifest untouched on a read-only dir", () => {
  const distDir = makeDistDir({ prerenderSecret: PUBLISHED_SECRET });
  const serverDir = path.join(distDir, "server");
  fs.chmodSync(serverDir, 0o500);
  try {
    const result = stripPrerenderSecret(distDir);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unwritable");
  } finally {
    fs.chmodSync(serverDir, 0o700);
  }
  assert.equal(readManifest(distDir).prerenderSecret, PUBLISHED_SECRET);
});

test("the warning names the internal route so the risk is visible", () => {
  const warning = getStripWarning("unwritable");
  assert.match(warning, /\/__vinext\/prerender/);
  assert.match(warning, /not writable/);
});
