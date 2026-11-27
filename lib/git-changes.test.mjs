import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";

const posix = process.platform !== "win32";

async function loadSubject() {
  return import("./git-status.ts");
}

async function loadChanges() {
  return import("./git-changes.ts");
}

test("empty newly added files do not invent a blank line in the diff", async () => {
  const { getGitFileDiff, getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-empty-diff-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    const filePath = nodePath.join(root, "empty.txt");
    fs.writeFileSync(filePath, "");
    assert.equal((await getGitStatus(root)).additions, 0);
    assert.deepEqual(await getGitFileDiff(root, filePath), { supported: false });
    execFileSync("git", ["-C", root, "add", "--", "empty.txt"]);
    assert.deepEqual(await getGitFileDiff(root, filePath), { supported: false });
    fs.writeFileSync(filePath, "\n");
    const blankLine = await getGitFileDiff(root, filePath);
    assert.equal(blankLine.supported, true);
    assert.ok(blankLine.patch.includes("@@ -0,0 +1,1 @@"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("parses the index's own changes, a rename naming where it came from", async () => {
  const { parseNameStatusZ } = await loadSubject();
  const changes = parseNameStatusZ([
    "M", "tracked.txt",
    "R98", "src/old-name.ts", "src/new-name.ts",
    "U", "conflict.txt",
    "A", "added.txt",
    "",
  ].join("\0"));

  assert.deepEqual([...changes.entries()], [
    ["tracked.txt", { code: "M" }],
    ["src/new-name.ts", { code: "R", originalPath: "src/old-name.ts" }],
    ["conflict.txt", { code: "U" }],
    ["added.txt", { code: "A" }],
  ]);
});

test("reads one file's status from questions that name only that file", async () => {
  const { classifyFileDiff } = await loadSubject();
  const MODIFIED = "diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
  const DELETED = "diff --git a/a.txt b/a.txt\ndeleted file mode 100644\n--- a/a.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-one\n";
  const CREATED = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+one\n";
  const facts = (over) => ({
    headDiff: "", comparedWithHead: true, inIndex: true, ignored: false, onDisk: true, ...over,
  });

  // Git's diff of the path stands for the work tree's side of the pair.
  assert.deepEqual(classifyFileDiff(facts({ headDiff: MODIFIED })), { status: "modified", source: "patch" });
  assert.deepEqual(classifyFileDiff(facts({ headDiff: DELETED, onDisk: false })), { status: "deleted", source: "patch" });
  assert.deepEqual(classifyFileDiff(facts({ headDiff: MODIFIED, indexChange: { code: "U" } })), { status: "conflict", source: "patch" });
  // The index's own letter names what HEAD holds, and answers nothing about the work tree.
  assert.deepEqual(classifyFileDiff(facts({ indexChange: { code: "D" }, headDiff: DELETED, onDisk: false })), { status: "deleted", source: "patch" });
  assert.deepEqual(classifyFileDiff(facts({ indexChange: { code: "A" }, headDiff: CREATED })), { status: "added", source: "patch" });
  assert.deepEqual(classifyFileDiff(facts({ indexChange: { code: "R", originalPath: "old.txt" } })), { status: "renamed", source: "rename-patch" });
  // A rename whose destination is gone is the deletion the reader sees.
  assert.deepEqual(classifyFileDiff(facts({ indexChange: { code: "R", originalPath: "old.txt" }, onDisk: false })), { status: "deleted", source: "rename-patch" });
  // `git add -N` stages a path without its content and so reports no change of its own;
  // the new file in Git's diff is the only place that added file appears.
  assert.deepEqual(classifyFileDiff(facts({ headDiff: CREATED })), { status: "added", source: "patch" });
  // Nothing in a diff, nothing in the index, and no ignore rule: an untracked file.
  assert.deepEqual(classifyFileDiff(facts({ inIndex: false })), { status: "untracked", source: "content" });
  assert.deepEqual(classifyFileDiff(facts({ inIndex: false, ignored: true })), null);
  assert.deepEqual(classifyFileDiff(facts()), null);
  // A repository without commits has no HEAD to compare with: what the index holds is new.
  assert.deepEqual(classifyFileDiff(facts({ headDiff: null, comparedWithHead: false })), { status: "added", source: "content" });
  assert.deepEqual(classifyFileDiff(facts({ headDiff: null, comparedWithHead: false, inIndex: false })), { status: "untracked", source: "content" });
  // A question that failed answers nothing on its own, but a change Git already showed needs
  // no further question about the index: an untracked or ignored path is never in a diff.
  assert.deepEqual(classifyFileDiff(facts({ inIndex: null, headDiff: MODIFIED })), { status: "modified", source: "patch" });
  assert.deepEqual(classifyFileDiff(facts({ inIndex: false, ignored: null, headDiff: MODIFIED })), { status: "modified", source: "patch" });
  assert.equal(classifyFileDiff(facts({ inIndex: null })), null);
  assert.equal(classifyFileDiff(facts({ inIndex: false, ignored: null })), null);
});

test("a file's diff asks Git about that file and never about the whole tree", async (t) => {
  if (process.platform === "win32") { t.skip("a shell script as Git needs a POSIX shell"); return; }
  const { getGitFileDiff } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-asked-"));
  const run = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  // The log sits outside the repository: a file in it would be a change of its own.
  const log = nodePath.join(nodePath.dirname(root), `asked-${nodePath.basename(root)}.log`);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(log, "");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
  });

  run("init", "-q");
  run("config", "--local", "user.name", "pi-web test");
  run("config", "--local", "user.email", "test@example.invalid");
  fs.writeFileSync(nodePath.join(root, "a.txt"), "one\n");
  fs.writeFileSync(nodePath.join(root, "other.txt"), "one\n");
  run("add", "--", "a.txt", "other.txt");
  run("commit", "-qm", "seed");
  fs.writeFileSync(nodePath.join(root, "a.txt"), "two\n");

  // Only now does Git go through the recorder: this is what one diff asks, not the fixture.
  const shim = nodePath.join(root, ".bin");
  fs.mkdirSync(shim);
  fs.writeFileSync(nodePath.join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log.replaceAll("\\", "/")}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${shim}${nodePath.delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  const diff = await getGitFileDiff(root, nodePath.join(root, "a.txt"));
  assert.equal(diff.supported, true);
  const asked = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  assert.ok(asked.length > 0, "Git was called at all");
  // The whole-tree listing is the one question that stats every file in the repository.
  assert.deepEqual(asked.filter((line) => line.startsWith("status ") || line.includes(" status ")
    || line.includes("--untracked-files")), [],
    `asked for the whole tree: ${JSON.stringify(asked)}`);
  // Everything else that reads a file names the one it was asked about. Two commands read no
  // file at all: the lookup of the repository, and the index's own comparison with HEAD.
  assert.deepEqual(asked.filter((line) => !line.includes("a.txt")
    && !line.includes("--show-toplevel") && !line.includes("--cached")), []);
});

// --- the paths a status reports, against a real Git -------------------------------------

/** A repository with one modified tracked file, and a link that leads to it. */
function linkedRepo() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-linked-"));
  const real = nodePath.join(root, "real-repo");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(nodePath.join(real, "a.txt"), "one\n");
  const git = (...args) => execFileSync("git", ["-C", real, ...args], { stdio: "ignore" });
  git("init", "-q");
  for (const [key, value] of [
    ["user.name", "pi-web test"],
    ["user.email", "test@example.invalid"],
    ["core.autocrlf", "false"],
    ["core.fsmonitor", "false"],
  ]) git("config", "--local", key, value);
  git("add", "--", "a.txt");
  git("commit", "-qm", "seed");
  fs.writeFileSync(nodePath.join(real, "a.txt"), "two\n");
  const link = nodePath.join(root, "link-repo");
  fs.symlinkSync(real, link);
  return { root, real, link };
}

test("a repository reached through a link reports files under the folder it was given", async (t) => {
  if (!posix) { t.skip("a symlink of one's own needs privileges on Windows"); return; }
  const { getGitStatus, getGitFileDiff } = await loadChanges();
  const { root, link } = linkedRepo();
  try {
    // What a file listing of that folder hands to a row: the link's own prefix.
    const listed = nodePath.join(link, "a.txt");
    const status = await getGitStatus(link);

    assert.equal(status.isGitRepository, true);
    const entry = status.files.find((file) => file.filePath === listed);
    assert.ok(entry, `a row's path carries its change; listed ${JSON.stringify(status.files.map((file) => file.filePath))}`);
    assert.equal(entry.status, "modified");
    // The line stats follow the folder as well, so the header's counts are this folder's.
    assert.ok(status.additions >= 1, `additions: ${status.additions}`);

    // And the diff route's lookup answers for the same path.
    const diff = await getGitFileDiff(link, listed);
    assert.equal(diff.supported, true);
    assert.ok(diff.patch.includes("+two"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repository above the folder asked about contributes no rows", async (t) => {
  if (!posix) { t.skip("a symlink of one's own needs privileges on Windows"); return; }
  const { getGitStatus } = await loadChanges();
  const { root, real, link } = linkedRepo();
  try {
    // A subfolder of the work tree still sees the file below it, and nothing above.
    const sub = nodePath.join(real, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(nodePath.join(sub, "b.txt"), "b\n");
    execFileSync("git", ["-C", real, "add", "--", "sub/b.txt"], { stdio: "ignore" });
    execFileSync("git", ["-C", real, "commit", "-qm", "sub"], { stdio: "ignore" });
    fs.writeFileSync(nodePath.join(sub, "b.txt"), "b changed\n");

    const inside = await getGitStatus(nodePath.join(link, "sub"));
    assert.deepEqual(inside.files.map((file) => file.filePath), [nodePath.join(link, "sub", "b.txt")]);

    // A folder beside the work tree is not in it: the upward search finds nothing (the
    // temporary folder above is no repository), so there is no view of changes to show.
    const outside = nodePath.join(root, "outside");
    fs.mkdirSync(outside);
    const empty = await getGitStatus(outside);
    assert.equal(empty.isGitRepository, false);
    assert.deepEqual(empty.files, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file outside the linked repository is still refused", async (t) => {
  if (!posix) { t.skip("a symlink of one's own needs privileges on Windows"); return; }
  const { getGitFileDiff } = await loadChanges();
  const { root, link } = linkedRepo();
  try {
    // The link does not widen what may be read: a file that is not in the
    // repository stays out, however it is named.
    const outside = nodePath.join(root, "outside.txt");
    fs.writeFileSync(outside, "not ours\n");
    const diff = await getGitFileDiff(link, outside);
    assert.equal(diff.supported, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- a listing that answers for the tree as it is now ---------------------------------
test("a file written after the last listing is in the next one", async () => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-fresh-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("config", "--local", "user.name", "pi-web test");
    git("config", "--local", "user.email", "test@example.invalid");
    fs.writeFileSync(nodePath.join(root, "tracked.txt"), "one\n");
    git("add", "--", "tracked.txt");
    git("commit", "-qm", "seed");

    const first = await getGitStatus(root);
    assert.deepEqual(first.files, []);

    // The listing is read from Git on every request, so a file written since the
    // last one is in the next answer: the changed-file badges are what the
    // reloads are for.
    fs.writeFileSync(nodePath.join(root, "written.txt"), "new\n");
    const second = await getGitStatus(root);
    assert.deepEqual(second.files.map((file) => nodePath.basename(file.filePath)), ["written.txt"]);
    assert.equal(second.files[0].status, "untracked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A repository with one committed file and the given untracked files (path → content). */
function untrackedRepo(files) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-untracked-"));
  const run = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  run("init", "-q");
  for (const [key, value] of [
    ["user.name", "pi-web test"],
    ["user.email", "test@example.invalid"],
    ["core.autocrlf", "false"],
    ["core.fsmonitor", "false"],
  ]) run("config", "--local", key, value);
  fs.writeFileSync(nodePath.join(root, "tracked.txt"), "one\n");
  run("add", "--", "tracked.txt");
  run("commit", "-qm", "seed");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(nodePath.dirname(nodePath.join(root, name)), { recursive: true });
    fs.writeFileSync(nodePath.join(root, name), content);
  }
  return root;
}

test("untracked files count their lines as a new-file diff does", async () => {
  const { getGitStatus } = await loadChanges();
  const chunk = 64 * 1024;
  const files = {
    "trailing.txt": "a\nb\n", // 2
    "no-trailing.txt": "a\nb", // 2
    "blank-lines.txt": "\n\n", // 2
    "crlf.txt": "a\r\nb\r\n", // 2
    "empty.txt": "", // 0
    "binary.bin": Buffer.from([0x61, 0x0a, 0x00, 0x62, 0x0a]), // 0
    // Invalid UTF-8 is still text, and its newlines are still newlines.
    "latin1.txt": Buffer.from([0xe9, 0x0a, 0xe2, 0x82, 0x0a, 0xc3]), // 3
    // Past the first chunks read: a NUL there still makes the file binary.
    "late-nul.txt": Buffer.concat([Buffer.from("x\n".repeat(chunk)), Buffer.from([0]), Buffer.from("\n")]), // 0
    // Lines across chunk boundaries, the last one unterminated.
    "chunks.txt": "y\n".repeat(chunk + 3) + "z", // chunk + 4
    "too-big.txt": "x\n".repeat(128 * 1024 + 1), // 0: over the preview's 256 KiB
  };
  // Enough files that several are read at once.
  for (let i = 0; i < 40; i++) files[`many/f${i}.json`] = `{\n  "i": ${i}\n}\n`; // 3 each
  const expected = 2 + 2 + 2 + 2 + 3 + (chunk + 4) + 40 * 3;
  const root = untrackedRepo(files);
  try {
    if (posix) fs.symlinkSync("trailing.txt", nodePath.join(root, "link.txt")); // 0: not a regular file
    fs.writeFileSync(nodePath.join(root, "tracked.txt"), "one\ntwo\n"); // 1 tracked addition
    const status = await getGitStatus(root);
    const untracked = status.files.filter((file) => file.status === "untracked");
    assert.equal(untracked.length, Object.keys(files).length + (posix ? 1 : 0));
    assert.equal(status.additions, expected + 1);
    assert.equal(status.deletions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an untracked file's lines are counted, and counted again once it changes", async () => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-lines-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("config", "--local", "user.name", "pi-web test");
    git("config", "--local", "user.email", "test@example.invalid");
    fs.writeFileSync(nodePath.join(root, "seed.txt"), "one\n");
    git("add", "--", "seed.txt");
    git("commit", "-qm", "seed");

    const untracked = nodePath.join(root, "notes.txt");
    fs.writeFileSync(untracked, "one\ntwo\nthree\n");
    assert.equal((await getGitStatus(root)).additions, 3);

    // The same file, one line more: the count follows the file, not the answer
    // that came before it. No wait: the file is younger than the quiet window, so
    // neither scan remembers it and both read it.
    fs.writeFileSync(untracked, "one\ntwo\nthree\nfour\n");
    assert.equal((await getGitStatus(root)).additions, 4);

    // A last line without a newline is a line of its own.
    fs.writeFileSync(untracked, "one\ntwo\n");
    assert.equal((await getGitStatus(root)).additions, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("untracked files are read without synchronous file calls (#1584)", async () => {
  // Synchronous reads of tens of thousands of untracked files held the server's
  // event loop, and every stream and request with it, for seconds.
  const { getGitStatus } = await loadChanges();
  const files = {};
  for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `line ${i}\n`;
  const root = untrackedRepo(files);
  const real = fs.realpathSync(root);
  const inRepo = (target) => typeof target === "string"
    && (target.startsWith(`${root}${nodePath.sep}`) || target.startsWith(`${real}${nodePath.sep}`));
  const syncCalls = [];
  const originals = {};
  for (const name of ["lstatSync", "statSync", "openSync", "readFileSync"]) {
    originals[name] = fs[name];
    fs[name] = function (target, ...rest) {
      if (inRepo(target)) syncCalls.push(`${name} ${nodePath.basename(target)}`);
      return originals[name].call(this, target, ...rest);
    };
  }
  try {
    const status = await getGitStatus(root);
    assert.equal(status.additions, 20);
    assert.deepEqual(syncCalls, []);
  } finally {
    Object.assign(fs, originals);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file whose timestamp is put back is counted again all the same", async () => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-racy-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("config", "--local", "user.name", "pi-web test");
    git("config", "--local", "user.email", "test@example.invalid");
    fs.writeFileSync(nodePath.join(root, "seed.txt"), "one\n");
    git("add", "--", "seed.txt");
    git("commit", "-qm", "seed");

    const untracked = nodePath.join(root, "notes.txt");
    fs.writeFileSync(untracked, "a\nb");
    // Every file is old enough at once, so the first scan remembers this one: the quiet
    // window is what the wait would have stood for, and its rule is what this asserts.
    assert.equal((await getGitStatus(root, undefined, 0)).additions, 2);
    const stamp = fs.statSync(untracked).mtime;

    // The file changes, and its modification time is put back where it was. The
    // bytes are the same length and the name the same, so only the file's own
    // change time gives it away — and a program cannot set that back.
    fs.writeFileSync(untracked, "ab\n");
    fs.utimesSync(untracked, stamp, stamp);
    assert.equal((await getGitStatus(root, undefined, 0)).additions, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted request stops the untracked scan (#1584)", async () => {
  const { getGitStatus } = await loadChanges();
  const files = {};
  for (let i = 0; i < 20; i++) files[`f${i}.txt`] = `line ${i}\n`;
  const root = untrackedRepo(files);
  const opened = [];
  const originalOpen = fs.promises.open;
  const controller = new AbortController();
  fs.promises.open = async function (target, ...rest) {
    opened.push(target);
    // The client goes away once the first file is being read.
    controller.abort();
    return originalOpen.call(this, target, ...rest);
  };
  try {
    await assert.rejects(getGitStatus(root, controller.signal), { name: "AbortError" });
    // The workers already reading finish their file; none starts another.
    assert.ok(opened.length <= 4, `opened ${opened.length} files`);
  } finally {
    fs.promises.open = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a scan leaves Git's index alone, so it takes no index lock", async () => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-index-lock-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    const tracked = nodePath.join(root, "a.txt");
    fs.writeFileSync(tracked, "a\n");
    git("add", "--", "a.txt");
    const indexPath = nodePath.join(root, ".git", "index");
    // A stat cache Git would otherwise refresh and write back while holding the lock.
    fs.utimesSync(tracked, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    const before = fs.readFileSync(indexPath);

    await getGitStatus(root);

    assert.ok(fs.readFileSync(indexPath).equals(before), "the scan wrote Git's index");
    assert.equal(fs.existsSync(`${indexPath}.lock`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an aborted request stops its Git children instead of running them out", async () => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-abort-child-"));
  try {
    const repo = nodePath.join(root, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "--quiet"]);
    fs.writeFileSync(nodePath.join(repo, "a.txt"), "a\n");
    execFileSync("git", ["-C", repo, "add", "--", "a.txt"]);

    // Git blocks inside the hook for three seconds: a scan that is only abandoned
    // comes back no sooner than that, a scan whose children are killed ends at once.
    const hookPath = nodePath.join(root, "hook.cjs").replaceAll("\\", "/");
    fs.writeFileSync(hookPath, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n");
    const node = process.execPath.replaceAll("\\", "/");
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", `'${node}' '${hookPath}'`]);

    const controller = new AbortController();
    const started = Date.now();
    const scan = getGitStatus(repo, controller.signal);
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(scan, { name: "AbortError" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `the scan ended ${elapsed} ms after it started`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a repository's fsmonitor hook does not receive this server's own variables", async (t) => {
  const { getGitStatus } = await loadChanges();
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-web-git-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = nodePath.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "--quiet"]);
  fs.writeFileSync(nodePath.join(repo, "a.txt"), "a\n");

  // Git runs the configured command through sh, with forward slashes on Windows too.
  const seenPath = nodePath.join(root, "hook-env.json").replaceAll("\\", "/");
  const hookPath = nodePath.join(root, "hook.cjs").replaceAll("\\", "/");
  fs.writeFileSync(hookPath, `require("fs").writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify(process.env));\n`);
  const node = process.execPath.replaceAll("\\", "/");
  execFileSync("git", ["-C", repo, "config", "core.fsmonitor", `'${node}' '${hookPath}'`]);

  const secrets = { PI_WEB_PASSWORD: "pi-web-login-secret", PORT: "30141", NEXT_RUNTIME: "nodejs" };
  for (const [name, value] of Object.entries(secrets)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }

  await getGitStatus(repo);

  assert.ok(fs.existsSync(seenPath), "the repository's own fsmonitor hook ran");
  const seen = JSON.parse(fs.readFileSync(seenPath, "utf8"));
  for (const name of Object.keys(secrets)) assert.equal(seen[name], undefined, name);
  assert.equal(seen.LC_ALL, "C");
  assert.equal(seen.GIT_OPTIONAL_LOCKS, "0");
});

test("a large tracked diff never reads the working copy synchronously", async () => {
  const { getGitFileDiff } = await loadChanges();
  const root = untrackedRepo({});
  const line = "abcdefghijklmnopqrstuvwxyz0123456789\n";
  const text = line.repeat(8000);
  const filePath = nodePath.join(root, "big.txt");
  fs.writeFileSync(filePath, text);
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-qm", "big"], { stdio: "ignore" });
  fs.writeFileSync(filePath, text.replace(line.trimEnd(), "CHANGED_SENTINEL"));

  const syncCalls = [];
  const originals = {};
  for (const name of ["lstatSync", "statSync", "openSync", "readFileSync"]) {
    originals[name] = fs[name];
    fs[name] = function (target, ...rest) {
      if (typeof target === "string" && ["big.txt", "small.txt"].includes(nodePath.basename(target))) {
        syncCalls.push(`${name} ${nodePath.basename(target)}`);
      }
      return originals[name].call(this, target, ...rest);
    };
  }
  try {
    // An untracked file is answered from its own bytes, so the patch is visible.
    const small = nodePath.join(root, "small.txt");
    fs.writeFileSync(small, "hello\n");
    const untracked = await getGitFileDiff(root, small);
    assert.equal(untracked.supported, true);
    assert.ok(untracked.patch.includes("+hello"), JSON.stringify(untracked));
    syncCalls.length = 0;

    // A tracked file's diff comes from HEAD's blobs: no synchronous read of the
    // working copy, whatever the file's size.
    const diff = await getGitFileDiff(root, filePath);
    assert.equal(diff.supported, true);
    assert.ok(diff.patch.includes("+CHANGED_SENTINEL"));
    assert.deepEqual(syncCalls, [], `synchronous reads: ${syncCalls}`);
  } finally {
    Object.assign(fs, originals);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
