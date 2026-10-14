import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Loaded through jiti: the rule module has extensionless sibling imports of its
// own, which only the bundler and Bun fill in (docs/agents/tests.md).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadSubject() {
  return jiti.import("./git-revert-rule.ts");
}

/** The rule read off a `git status --porcelain` XY pair. */
const pair = async (code) => {
  const { isGitPathRevertible } = await loadSubject();
  return isGitPathRevertible({ indexStatus: code[0], worktreeStatus: code[1] });
};

test("a change Git can undo offers a revert, staged or not", async () => {
  // Content HEAD already has: the file goes back to it whether it was staged or not.
  assert.equal(await pair(" M"), true, "modified in the working tree");
  assert.equal(await pair("M "), true, "modified and staged");
  assert.equal(await pair("MM"), true, "staged and then changed again");
  assert.equal(await pair(" D"), true, "deleted in the working tree");
  assert.equal(await pair("D "), true, "deletion staged");
  assert.equal(await pair("MD"), true, "staged change whose file is now gone");
});

test("what HEAD never held is left alone", async () => {
  // Reverting these would delete something instead of putting something back.
  assert.equal(await pair("A "), false, "staged for the first time");
  assert.equal(await pair("AM"), false, "staged new whose contents then moved");
  assert.equal(await pair("??"), false, "untracked");
  assert.equal(await pair("R "), false, "renamed");
  assert.equal(await pair("RM"), false, "renamed and changed");
  assert.equal(await pair("C "), false, "copied");
  assert.equal(await pair("UU"), false, "conflicted");
  assert.equal(await pair("AA"), false, "added by both sides");
  assert.equal(await pair("T "), false, "became a link or a socket");
  assert.equal(await pair("! "), false, "ignored");
});

test("an entry with nothing changed on either side is not a change", async () => {
  assert.equal(await pair("  "), false);
});

test("every refusal has a message, and the message keys are the ones the app renders", async () => {
  const { GIT_REVERT_REFUSAL_KEYS, isGitPathRevertible } = await loadSubject();
  assert.deepEqual(Object.keys(GIT_REVERT_REFUSAL_KEYS).sort(), [
    "failed",
    "no_changes",
    "no_commits",
    "not_git",
    "not_revertible",
    "outside_repository",
  ]);
  for (const key of Object.values(GIT_REVERT_REFUSAL_KEYS)) {
    assert.ok(key.startsWith("files.revert"), key);
  }
  // The rule is the only thing the menu reads, so it must not need the server.
  assert.equal(typeof isGitPathRevertible, "function");
});
