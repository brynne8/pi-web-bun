import assert from "node:assert/strict";
import test from "node:test";
import { SESSION, withAgentSession } from "./__fixtures__/agent-session-harness.mjs";

// The panel's active time is the newer of the two readings: the live state leads while a
// run appends entries behind the snapshot, the snapshot leads after a compaction or a
// reload, which install a newer one without reading the state (#1334).

const sessionFile = (id, totalActiveMs) => ({
  ...SESSION,
  sessionId: id,
  filePath: `/${id}.jsonl`,
  totalActiveMs,
  stats: { tokens: { total: 1 } },
});

const setup = ({ snapshotActiveMs, liveActiveMs } = {}) => withAgentSession({
  sessionReply: sessionFile("A", snapshotActiveMs),
  agentState: liveActiveMs === undefined ? {} : { totalActiveMs: liveActiveMs },
}, async (env) => {
  // Opening the stream is what reads the live state.
  await env.connect();
  return env.hook.result.sessionStats;
});

test("a live reading ahead of the snapshot is shown while a run appends entries", async () => {
  const stats = await setup({ snapshotActiveMs: 383_100_000, liveActiveMs: 406_500_000 });
  assert.equal(stats?.totalActiveMs, 406_500_000);
});

test("a newer snapshot wins over an older live reading, as after a compaction", async () => {
  // Manual compaction appends its entry and only reloads the session, so the
  // snapshot advances without another state read.
  const stats = await setup({ snapshotActiveMs: 407_327_590, liveActiveMs: 406_500_000 });
  assert.equal(stats?.totalActiveMs, 407_327_590);
});

test("a live reading from another session is ignored", async () => {
  const stats = await withAgentSession({
    sessionReply: (id) => sessionFile(id, id === "A" ? 999_000 : 1000),
    agentState: { totalActiveMs: 999_000 },
  }, async (env) => {
    await env.connect();
    assert.equal(env.hook.result.sessionStats?.totalActiveMs, 999_000);
    // The page moved to another session: the reading the previous one's stream read
    // must not follow it, and the snapshot its own file carries is what shows.
    // No stream for it here: a page that just switched has not opened one.
    const other = await env.switchTo({ ...SESSION, id: "B", name: "B" });
    return other.hook.result.sessionStats;
  });
  assert.equal(stats?.totalActiveMs, 1000);
});

test("without either reading the panel shows none", async () => {
  assert.equal((await setup({}))?.totalActiveMs, undefined);
  assert.equal((await setup({ liveActiveMs: 5000 }))?.totalActiveMs, 5000);
});
