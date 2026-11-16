import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Loaded through jiti: the rule module has extensionless sibling imports of its
// own, which only the bundler and Bun fill in (docs/agents/tests.md).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadSubject() {
  return jiti.import("./git-revert-rule.ts");
}

/** The action the rule reads off a `git status --porcelain` XY pair. */
const actionOf = async (code) => {
  const { gitRevertAction } = await loadSubject();
  return gitRevertAction({ indexStatus: code[0], worktreeStatus: code[1] });
};

test("a change Git can undo is restored, staged or not", async () => {
  // Content HEAD already has: the file goes back to it whether it was staged or not.
  assert.equal(await actionOf(" M"), "restore", "modified in the working tree");
  assert.equal(await actionOf("M "), "restore", "modified and staged");
  assert.equal(await actionOf("MM"), "restore", "staged and then changed again");
  assert.equal(await actionOf(" D"), "restore", "deleted in the working tree");
  assert.equal(await actionOf("D "), "restore", "deletion staged");
  assert.equal(await actionOf("MD"), "restore", "staged change whose file is now gone");
});

test("a file HEAD never held is deleted: the change only goes away with the file", async () => {
  assert.equal(await actionOf("??"), "delete", "untracked");
  assert.equal(await actionOf("A "), "delete", "staged for the first time");
  assert.equal(await actionOf("AM"), "delete", "staged new whose contents then moved");
  assert.equal(await actionOf("AD"), "delete", "staged new then gone from the working tree");
});

test("what neither action covers is left alone", async () => {
  assert.equal(await actionOf("AU"), null, "unmerged: both sides are the reader's work");
  assert.equal(await actionOf("R "), null, "renamed");
  assert.equal(await actionOf("RM"), null, "renamed and changed");
  assert.equal(await actionOf("C "), null, "copied");
  assert.equal(await actionOf("UU"), null, "conflicted");
  assert.equal(await actionOf("AA"), null, "added by both sides");
  assert.equal(await actionOf("T "), null, "became a link or a socket");
  assert.equal(await actionOf("! "), null, "ignored");
});

test("an entry with nothing changed on either side is not a change", async () => {
  assert.equal(await actionOf("  "), null);
});

test("every refusal has a message, and the message keys are the ones the app renders", async () => {
  const { GIT_REVERT_REFUSAL_KEYS, gitRevertAction } = await loadSubject();
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
  assert.equal(typeof gitRevertAction, "function");
});
