import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { writePrivateFileAtomicSync, writeSessionFileAtomicSync } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});

test("a session write keeps the destination's mode and takes 0644 for a new file", (t) => {
  const root = createTempRoot(t);
  const kept = path.join(root, "kept.jsonl");
  fs.writeFileSync(kept, "old");
  if (process.platform !== "win32") fs.chmodSync(kept, 0o640);

  writeSessionFileAtomicSync(kept, "new");

  assert.equal(fs.readFileSync(kept, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root).sort(), ["kept.jsonl"]);

  // The umask is pinned for the created file only, so its mode is this test's
  // and not the machine's.
  const created = path.join(root, "created.jsonl");
  const previousUmask = process.umask(0o022);
  try {
    writeSessionFileAtomicSync(created, "hello");
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(fs.readFileSync(created, "utf8"), "hello");
  assert.deepEqual(fs.readdirSync(root).sort(), ["created.jsonl", "kept.jsonl"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(kept).mode & 0o777, 0o640, "an existing session file keeps the bits pi gave it");
    assert.equal(fs.statSync(created).mode & 0o777, 0o644, "a new session file takes pi's default, not the private 0600");
  }
});

test("an exclusive session write refuses an existing destination, a plain one replaces it", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "child.jsonl");
  fs.writeFileSync(destination, "original");

  assert.throws(
    () => writeSessionFileAtomicSync(destination, "clobber", { exclusive: true }),
    (error) => error.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "original", "the existing file is untouched");
  assert.deepEqual(fs.readdirSync(root), ["child.jsonl"], "no temporary file is left behind");

  // The re-parent rewrite is the one caller that must replace an existing file.
  writeSessionFileAtomicSync(destination, "replaced");
  assert.equal(fs.readFileSync(destination, "utf8"), "replaced");
  assert.deepEqual(fs.readdirSync(root), ["child.jsonl"]);
});
