import assert from "node:assert/strict";
import test from "node:test";

import {
  clearReadSnapshotViewChoices,
  readSnapshotViewChoice,
  saveReadSnapshotViewChoice,
} from "./read-snapshot-view-state.ts";

test("a read card's panel choices come back to that card only", () => {
  clearReadSnapshotViewChoices();
  assert.equal(readSnapshotViewChoice("call-a"), undefined);

  saveReadSnapshotViewChoice("call-a", { displayMode: "source", wrapLines: false });
  assert.deepEqual(readSnapshotViewChoice("call-a"), { displayMode: "source", wrapLines: false });
  // Re-opening another read of another call asks its own question.
  assert.equal(readSnapshotViewChoice("call-b"), undefined);
});

test("an unmade wrap choice stays unmade instead of becoming a no", () => {
  clearReadSnapshotViewChoices();
  saveReadSnapshotViewChoice("call-a", { displayMode: "source" });
  assert.equal(readSnapshotViewChoice("call-a").wrapLines, undefined);
  saveReadSnapshotViewChoice("call-a", { displayMode: "source", wrapLines: true });
  assert.equal(readSnapshotViewChoice("call-a").wrapLines, true);
});

test("the store keeps the 20 cards touched last and drops the one left longest ago", () => {
  clearReadSnapshotViewChoices();
  for (let i = 0; i < 20; i++) {
    saveReadSnapshotViewChoice(`call-${i}`, { displayMode: "preview" });
  }
  // Touching the oldest one puts it back at the front of the eviction order.
  readSnapshotViewChoice("call-0");
  saveReadSnapshotViewChoice("call-20", { displayMode: "preview" });

  assert.equal(readSnapshotViewChoice("call-1"), undefined);
  assert.notEqual(readSnapshotViewChoice("call-0"), undefined);
  assert.notEqual(readSnapshotViewChoice("call-20"), undefined);
});

test("a card with no id keeps no state at all", () => {
  clearReadSnapshotViewChoices();
  saveReadSnapshotViewChoice(undefined, { displayMode: "source" });
  assert.equal(readSnapshotViewChoice(undefined), undefined);
});
