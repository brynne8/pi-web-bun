import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-diff-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRootsCache = globalThis.__piAllowedRootsCache;
const previousAdditionalRoots = globalThis.__piAdditionalAllowedRoots;
delete globalThis.__piAllowedRootsCache;
delete globalThis.__piAdditionalAllowedRoots;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  globalThis.__piAllowedRootsCache = previousRootsCache;
  globalThis.__piAdditionalAllowedRoots = previousAdditionalRoots;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { NextRequest } = await jiti.import("vinext/shims/server");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(base, "repo-"));
  git(root, "init", "--quiet");
  allowFileRoot(root);
  return root;
}

function request(cwd, filePath) {
  const url = new URL("http://localhost/api/git/diff");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("path", filePath);
  return GET(new NextRequest(url));
}

function directoryLink(target, link) {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

test("preserves trailing spaces in Git file and directory paths", { skip: process.platform === "win32" }, async () => {
  const root = path.join(fixture(), "working tree ");
  fs.mkdirSync(root);
  git(root, "init", "--quiet");
  const filePath = path.join(root, "notes.txt ");
  fs.writeFileSync(filePath, "space-suffixed file\n");
  const response = await request(root, filePath);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.supported, true);
  assert.ok(result.patch.includes("+space-suffixed file"));

  const { GET: getStatus } = await jiti.import("../status/route.ts");
  const url = new URL("http://localhost/api/git/status");
  url.searchParams.set("cwd", root);
  const statusResponse = await getStatus(new NextRequest(url));
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.ok(status.files.some((file) => file.filePath === filePath));
});

test("refuses a file reached through an outside junction before returning any content", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret-marker\n");
  directoryLink(outside, path.join(root, "linked"));
  const response = await request(root, path.join(root, "linked", "secret.txt"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("refuses missing descendants of an outside or dangling junction", async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "missing-outside-"));
  directoryLink(outside, path.join(root, "linked"));
  const filePath = path.join(root, "linked", "missing-parent", "missing.txt");
  assert.equal((await request(root, filePath)).status, 403);
  fs.rmdirSync(outside);
  assert.equal((await request(root, filePath)).status, 403);
});

test("allows a Windows junction after its target is explicitly allowed", { skip: process.platform !== "win32" }, async () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(base, "allowed-outside-"));
  fs.writeFileSync(path.join(outside, "notes.txt"), "explicitly allowed text\n");
  directoryLink(outside, path.join(root, "linked"));
  const filePath = path.join(root, "linked", "notes.txt");
  assert.equal((await request(root, filePath)).status, 403);
  allowFileRoot(outside);
  const response = await request(root, filePath);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.supported, true);
  assert.equal(result.status, "untracked");
  assert.ok(result.patch.includes("+explicitly allowed text"));
});

test("returns ordinary modified and untracked text diffs", async () => {
  const root = fixture();
  const tracked = path.join(root, "tracked.txt");
  fs.writeFileSync(tracked, "original\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  fs.writeFileSync(tracked, "updated\n");
  const untracked = path.join(root, "new.txt");
  fs.writeFileSync(untracked, "new text\n");
  for (const [filePath, status, content] of [[tracked, "modified", "+updated"], [untracked, "untracked", "+new text"]]) {
    const response = await request(root, filePath);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supported, true);
    assert.equal(result.status, status);
    assert.ok(result.patch.includes(content));
  }
});

test("finds the file's repository when the cwd is a plain folder holding several", async () => {
  const parent = fs.mkdtempSync(path.join(base, "parent-"));
  allowFileRoot(parent);
  const repos = ["frontend", "backend"].map((name) => path.join(parent, name));
  for (const repo of repos) {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    git(repo, "init", "--quiet");
    fs.writeFileSync(path.join(repo, "src", "app.txt"), "original\n");
    fs.writeFileSync(path.join(repo, "gone.txt"), "tracked original\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  }
  const [frontend, backend] = repos;
  fs.writeFileSync(path.join(frontend, "src", "app.txt"), "updated\n");
  fs.rmSync(path.join(backend, "src"), { recursive: true });
  for (const [filePath, status, content] of [
    [path.join(frontend, "src", "app.txt"), "modified", "+updated"],
    [path.join(backend, "src", "app.txt"), "deleted", "-original"],
  ]) {
    const response = await request(parent, filePath);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supported, true);
    assert.equal(result.status, status);
    assert.ok(result.patch.includes(content));
  }
  assert.deepEqual(await (await request(parent, path.join(backend, "gone.txt"))).json(), { supported: false });
});

test("does not run the fsmonitor hook of a checkout other than the cwd's", { skip: process.platform === "win32" }, async () => {
  const parent = fs.mkdtempSync(path.join(base, "hooked-parent-"));
  allowFileRoot(parent);
  const nested = path.join(parent, "nested");
  fs.mkdirSync(nested);
  git(nested, "init", "--quiet");
  fs.writeFileSync(path.join(nested, "app.txt"), "original\n");
  git(nested, "add", ".");
  git(nested, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  const marker = path.join(base, "fsmonitor-ran");
  const hook = path.join(base, "fsmonitor-hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(nested, "config", "core.fsmonitor", hook);
  fs.writeFileSync(path.join(nested, "app.txt"), "updated\n");

  const result = await (await request(parent, path.join(nested, "app.txt"))).json();
  assert.equal(result.supported, true);
  assert.ok(result.patch.includes("+updated"));
  assert.equal(fs.existsSync(marker), false);
});

test("preserves deleted tracked diffs with existing or missing parents", async () => {
  const root = fixture();
  const nested = path.join(root, "parent", "child");
  fs.mkdirSync(nested, { recursive: true });
  const files = [path.join(root, "deleted.txt"), path.join(nested, "deleted.txt")];
  for (const file of files) fs.writeFileSync(file, "tracked original\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  for (const file of files) fs.unlinkSync(file);
  fs.rmdirSync(nested);
  fs.rmdirSync(path.dirname(nested));
  for (const file of files) {
    const response = await request(root, file);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supported, true);
    assert.equal(result.status, "deleted");
    assert.ok(result.patch.includes("-tracked original"));
  }
});

test("rejects parent traversal and keeps an absent untracked path unsupported", async () => {
  const root = fixture();
  const response = await request(root, `${root}${path.sep}unused${path.sep}..${path.sep}missing.txt`);
  assert.equal(response.status, 403);
  const missing = await request(root, path.join(root, "absent", "missing.txt"));
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { supported: false });
});

test("a staged rename is shown with the name the file had", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "old.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  git(root, "mv", "old.txt", "new.txt");
  fs.writeFileSync(path.join(root, "new.txt"), "one\ntwo\nthree\n");

  const result = await (await request(root, path.join(root, "new.txt"))).json();
  assert.equal(result.supported, true);
  assert.equal(result.status, "renamed");
  // The name it came from comes with it, which is why Git's index is asked as well as the
  // file: a pathspec of the new name alone cannot see the change to the old one.
  assert.ok(result.patch.includes("rename from old.txt"), result.patch);
  assert.ok(result.patch.includes("+three"), result.patch);
});

test("a rename that moved no content shows nothing, and its missing destination is a deletion", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "old.txt"), "one\ntwo\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  git(root, "mv", "old.txt", "new.txt");

  // A rename alone is no lines moved, and a diff of nothing is not a diff.
  assert.deepEqual(await (await request(root, path.join(root, "new.txt"))).json(), { supported: false });

  fs.unlinkSync(path.join(root, "new.txt"));
  const result = await (await request(root, path.join(root, "new.txt"))).json();
  assert.equal(result.supported, true);
  assert.equal(result.status, "deleted");
  assert.ok(result.patch.includes("-two"), result.patch);
});

test("an ignored file is no one's change and has no diff", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "build/\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  fs.mkdirSync(path.join(root, "build"));
  const ignored = path.join(root, "build", "out.js");
  fs.writeFileSync(ignored, "compiled\n");

  assert.deepEqual(await (await request(root, ignored)).json(), { supported: false });
  // The rule is the ignore rules', not the folder's: a tracked file beside them still answers.
  fs.writeFileSync(path.join(root, "a.txt"), "two\n");
  assert.equal((await (await request(root, path.join(root, "a.txt"))).json()).status, "modified");
});

test("a conflicted file is reported as a conflict, with the markers Git left in it", async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", ".");
  const commit = (...args) => git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", ...args);
  commit("--quiet", "-m", "fixture");
  const main = git(root, "rev-parse", "--abbrev-ref", "HEAD").trim();
  fs.writeFileSync(path.join(root, "a.txt"), "branch a\n");
  commit("--quiet", "-am", "a");
  git(root, "checkout", "--quiet", "-b", "other", "HEAD~1");
  fs.writeFileSync(path.join(root, "a.txt"), "branch b\n");
  commit("--quiet", "-am", "b");
  git(root, "checkout", "--quiet", main);
  try {
    git(root, "merge", "other");
  } catch {
    // The conflict is the fixture.
  }

  const result = await (await request(root, path.join(root, "a.txt"))).json();
  assert.equal(result.supported, true);
  assert.equal(result.status, "conflict");
  assert.ok(result.patch.includes("+<<<<<<< HEAD"), result.patch);
});
