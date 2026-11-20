import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./path-security.ts");
}

test("resolves the target first and stops at the first matching lexical root", async (t) => {
  const { isExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const target = path.join(allowed, "file.txt");
  const missing = path.join(allowed, "missing.txt");
  fs.mkdirSync(allowed);
  fs.writeFileSync(target, "file");
  const roots = new Set([path.join(base, "unrelated"), allowed, base]);
  const realpathSync = fs.realpathSync;
  const calls = [];
  t.mock.method(fs, "realpathSync", (name) => {
    calls.push(name);
    return realpathSync(name);
  });

  assert.equal(isExistingPathWithinRoots(target, roots), true);
  assert.deepEqual(calls.splice(0), [target, allowed]);
  assert.equal(isExistingPathWithinRoots(missing, roots), false);
  assert.deepEqual(calls, [missing]);
});

test("falls back to another canonical root and resolves that root afresh on each check", async (t) => {
  const { isExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const destination = path.join(base, "destination");
  const other = path.join(base, "other");
  for (const dir of [allowed, destination, other]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(destination, "file.txt"), "file");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const link = path.join(allowed, "link");
  const alias = path.join(base, "alias");
  fs.symlinkSync(destination, link, linkType);
  fs.symlinkSync(destination, alias, linkType);
  const target = path.join(link, "file.txt");
  const roots = new Set([path.join(base, "stale"), allowed, alias]);

  assert.equal(isExistingPathWithinRoots(target, roots), true);
  fs.rmSync(alias);
  fs.symlinkSync(other, alias, linkType);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("rejects a `..` that climbs out beside a link's target", async (t) => {
  const { hasParentDirectorySegment, isExistingPathWithinRoots } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(outside, "linked"), { recursive: true });
  fs.symlinkSync(path.join(outside, "linked"), path.join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([allowed]);

  // realpathSync reads `allowed/link/..` as `allowed`; opening it lists `outside`.
  const climb = `${allowed}${path.sep}link${path.sep}..`;
  assert.equal(isExistingPathWithinRoots(climb, roots), false);
  assert.equal(isExistingPathWithinRoots(path.join(allowed, "link"), new Set([allowed, outside])), true);

  assert.equal(hasParentDirectorySegment("/a/b/../c"), true);
  assert.equal(hasParentDirectorySegment("C:\\a\\..\\c"), true);
  assert.equal(hasParentDirectorySegment("/a/..b/c.."), false);
  if (process.platform !== "win32") assert.equal(hasParentDirectorySegment("/a/b\\..\\c"), false);
});

test("an unreadable file inside a root is admitted, an unreadable link out of one is not", async (t) => {
  // Bun's realpathSync reads the file where Node's walks directories only, so this
  // path is where the two runners part: EACCES on Bun, a real path on Node. A name
  // that is not a link is the parent's own path plus itself, so it is admitted either
  // way; a link may point outside, so it stays refused.
  const { isExistingPathWithinRoots } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-access-")));
  t.after(() => {
    fs.chmodSync(path.join(base, "allowed", "private.txt"), 0o600);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(allowed, "private.txt"), "private");
  fs.chmodSync(path.join(allowed, "private.txt"), 0);
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(allowed, "link.txt"));
  const roots = new Set([allowed]);

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    assert.equal(isExistingPathWithinRoots(path.join(allowed, "private.txt"), roots), true);
  }
  assert.equal(isExistingPathWithinRoots(path.join(allowed, "link.txt"), roots), false);
});
