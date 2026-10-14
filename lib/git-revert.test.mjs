import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-revert-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// Nothing is written to process.env here. lib/file-tree-visibility.test.mjs sets
// GIT_CONFIG_GLOBAL and GIT_CEILING_DIRECTORIES for its own fixtures, and under
// `bun test` one process runs the whole suite, so a second file setting them is
// that file's isolation quietly replaced (docs/agents/tests.md). The isolation this
// file needs goes into each fixture's own .git/config instead, which outranks any
// global or system config for the status reads the module under test performs.
const localConfig = [
  ["user.name", "pi-web test"],
  ["user.email", "test@example.invalid"],
  ["core.autocrlf", "false"],
  ["core.fsmonitor", "false"],
  ["core.excludesFile", ""],
  ["status.showUntrackedFiles", "all"],
  ["commit.gpgsign", "false"],
];

// Loaded through jiti: the module under test imports its siblings by extensionless
// name, which only the bundler and Bun fill in (docs/agents/tests.md).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { revertGitPath } = await jiti.import("./git-revert.ts");

let fixtureCount = 0;

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

/** A repository with one commit holding `files`. */
function repo(files) {
  const dir = path.join(root, `fixture-${++fixtureCount}`);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [key, value] of localConfig) git(dir, "config", "--local", key, value);
  git(dir, "add", "--", ...Object.keys(files));
  git(dir, "commit", "-qm", "seed");
  return dir;
}

function plainDir(files) {
  const dir = path.join(root, `fixture-${++fixtureCount}`);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}

const statusOf = (dir) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" });

test("an unstaged change goes back to the committed bytes", async () => {
  const dir = repo({ "src/main.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "src/main.ts"), "two\nthree\n");

  const result = await revertGitPath(dir, path.join(dir, "src/main.ts"));

  assert.deepEqual(result, { reverted: true, filePath: path.join(dir, "src/main.ts") });
  assert.equal(fs.readFileSync(path.join(dir, "src/main.ts"), "utf8"), "one\n");
  assert.equal(statusOf(dir), "");
});

test("a staged change is unstaged and reverted by the same action", async () => {
  const dir = repo({ "notes.md": "one\n" });
  fs.writeFileSync(path.join(dir, "notes.md"), "staged edit\n");
  git(dir, "add", "--", "notes.md");
  assert.equal(statusOf(dir).trim(), "M  notes.md");

  assert.equal((await revertGitPath(dir, path.join(dir, "notes.md"))).reverted, true);
  assert.equal(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), "one\n");
  assert.equal(statusOf(dir), "");
});

test("a change split between the index and the working tree goes back whole", async () => {
  const dir = repo({ "split.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "split.ts"), "staged\n");
  git(dir, "add", "--", "split.ts");
  fs.writeFileSync(path.join(dir, "split.ts"), "staged plus unstaged\n");
  assert.equal(statusOf(dir).trim(), "MM split.ts");

  assert.equal((await revertGitPath(dir, path.join(dir, "split.ts"))).reverted, true);
  assert.equal(fs.readFileSync(path.join(dir, "split.ts"), "utf8"), "one\n");
  assert.equal(statusOf(dir), "");
});

test("a deleted file comes back, deleted-and-staged included", async () => {
  for (const stage of ["worktree", "staged"]) {
    const dir = repo({ "gone.txt": "kept\n" });
    fs.rmSync(path.join(dir, "gone.txt"));
    if (stage === "staged") git(dir, "add", "--", "gone.txt");

    const result = await revertGitPath(dir, path.join(dir, "gone.txt"));

    assert.equal(result.reverted, true, stage);
    assert.equal(fs.readFileSync(path.join(dir, "gone.txt"), "utf8"), "kept\n", stage);
    assert.equal(statusOf(dir), "", stage);
  }
});

test("an untracked file is refused and left where it is", async () => {
  const dir = repo({ "tracked.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "scratch.ts"), "my own work\n");

  const result = await revertGitPath(dir, path.join(dir, "scratch.ts"));

  assert.equal(result.reverted, false);
  assert.equal(result.code, "not_revertible");
  assert.equal(fs.readFileSync(path.join(dir, "scratch.ts"), "utf8"), "my own work\n");
});

test("a file staged for the first time is refused: HEAD has no version of it", async () => {
  const dir = repo({ "tracked.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "brand-new.ts"), "all of it new\n");
  git(dir, "add", "--", "brand-new.ts");

  const result = await revertGitPath(dir, path.join(dir, "brand-new.ts"));

  assert.equal(result.reverted, false);
  assert.equal(result.code, "not_revertible");
  assert.equal(fs.readFileSync(path.join(dir, "brand-new.ts"), "utf8"), "all of it new\n");
  assert.equal(statusOf(dir).trim(), "A  brand-new.ts");
});

test("a rename is refused: reverting it would delete the name the file has now", async () => {
  const dir = repo({ "old-name.ts": "one\n" });
  fs.renameSync(path.join(dir, "old-name.ts"), path.join(dir, "new-name.ts"));
  git(dir, "add", "-A", "--");

  const result = await revertGitPath(dir, path.join(dir, "new-name.ts"));

  assert.equal(result.reverted, false);
  assert.equal(result.code, "not_revertible");
  assert.equal(fs.existsSync(path.join(dir, "new-name.ts")), true);
});

test("a path with pathspec magic reverts itself and no other file", async () => {
  const dir = repo({ "a[1].ts": "one\n", "a1.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "a[1].ts"), "two\n");
  fs.writeFileSync(path.join(dir, "a1.ts"), "two\n");

  const result = await revertGitPath(dir, path.join(dir, "a[1].ts"));

  // Without the literal pathspec, `a[1].ts` is a glob and both files would go back.
  assert.equal(result.reverted, true);
  assert.equal(fs.readFileSync(path.join(dir, "a[1].ts"), "utf8"), "one\n");
  assert.equal(fs.readFileSync(path.join(dir, "a1.ts"), "utf8"), "two\n");
  assert.equal(statusOf(dir), " M a1.ts\n");
});

test("a tracked file with no changes says so and nothing is written", async () => {
  const dir = repo({ "quiet.ts": "one\n" });

  const result = await revertGitPath(dir, path.join(dir, "quiet.ts"));

  assert.equal(result.reverted, false);
  assert.equal(result.code, "no_changes");
});

test("a folder that is not a Git repository is refused", async () => {
  const dir = plainDir({ "loose.txt": "one\n" });

  const result = await revertGitPath(dir, path.join(dir, "loose.txt"));

  assert.equal(result.reverted, false);
  assert.equal(result.code, "not_git");
});

test("a file outside the repository's working tree is refused", async () => {
  const dir = repo({ "inside.ts": "one\n" });
  const outside = path.join(root, `outside-${fixtureCount}.txt`);
  fs.writeFileSync(outside, "not mine\n");

  const result = await revertGitPath(dir, outside);

  assert.equal(result.reverted, false);
  assert.equal(result.code, "outside_repository");
  assert.equal(fs.readFileSync(outside, "utf8"), "not mine\n");
});

test("a working-tree link that leads out of the repository is refused", async () => {
  const dir = repo({ "inside.ts": "one\n" });
  const outside = path.join(root, `outside-${fixtureCount}.txt`);
  fs.writeFileSync(outside, "not mine\n");
  const link = path.join(dir, "link-out.txt");
  fs.symlinkSync(outside, link);
  git(dir, "add", "--", "link-out.txt");
  git(dir, "commit", "-qm", "link");
  // The link now points outside the repository, and its contents have moved.
  fs.rmSync(link);
  fs.symlinkSync(path.join(root, `outside-moved-${fixtureCount}.txt`), link);

  const result = await revertGitPath(dir, link);

  assert.equal(result.reverted, false);
  // A link is not a regular file, so the checkout does not run whichever way it points.
  assert.equal(result.code, "not_revertible");
  assert.equal(fs.readFileSync(outside, "utf8"), "not mine\n");
});

test("a directory is refused: a revert is one file's checkout, not a subtree's", async () => {
  const dir = repo({ "src/main.ts": "one\n" });
  fs.writeFileSync(path.join(dir, "src/main.ts"), "two\n");

  const result = await revertGitPath(dir, path.join(dir, "src"));

  // Git lists the changed file, never the folder, so the folder has no entry.
  assert.equal(result.reverted, false);
  assert.equal(result.code, "no_changes");
  assert.equal(fs.readFileSync(path.join(dir, "src/main.ts"), "utf8"), "two\n");
});
