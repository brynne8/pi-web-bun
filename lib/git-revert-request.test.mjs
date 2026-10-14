import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Loaded through jiti: the request module imports the rule by its extensionless
// name, which only the bundler and Bun fill in (docs/agents/tests.md).
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

async function loadSubject() {
  return jiti.import("./git-revert-request.ts");
}

/** A fetch that answers what the route answers, so the mapping is what is tested. */
function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetchImpl };
}

const json = (status, body) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test("a revert posts the project and the file it was asked for", async () => {
  const { revertGitFileChanges } = await loadSubject();
  const { calls, fetchImpl } = fakeFetch(json(200, { reverted: true, filePath: "/repo/src/main.ts" }));

  const outcome = await revertGitFileChanges("/repo", "/repo/src/main.ts", fetchImpl);

  assert.deepEqual(outcome, { reverted: true, code: null, error: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/git/revert");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { cwd: "/repo", path: "/repo/src/main.ts" });
});

test("a refusal keeps the code the toast's message is chosen from", async () => {
  const { revertGitFileChanges } = await loadSubject();
  const { fetchImpl } = fakeFetch(json(409, { error: "This file has no Git changes", code: "no_changes" }));

  assert.deepEqual(await revertGitFileChanges("/repo", "/repo/x.ts", fetchImpl), {
    reverted: false,
    code: "no_changes",
    error: "This file has no Git changes",
  });
});

test("an unknown or missing code still gets a message, with the server's words as the tail", async () => {
  const { revertGitFileChanges } = await loadSubject();

  for (const body of [{ error: "boom" }, { error: "boom", code: "made_up" }, {}]) {
    const { fetchImpl } = fakeFetch(json(409, body));
    const outcome = await revertGitFileChanges("/repo", "/repo/x.ts", fetchImpl);
    assert.equal(outcome.reverted, false);
    assert.equal(outcome.code, "failed");
  }
});

test("a reply that is not JSON, and a request that never landed, are both failures", async () => {
  const { revertGitFileChanges } = await loadSubject();

  const { fetchImpl: noJson } = fakeFetch(() => ({
    ok: false,
    status: 502,
    json: async () => { throw new Error("not json"); },
  }));
  assert.deepEqual(await revertGitFileChanges("/repo", "/repo/x.ts", noJson), {
    reverted: false,
    code: "failed",
    error: "HTTP 502",
  });

  const throwing = async () => { throw new Error("offline"); };
  assert.deepEqual(await revertGitFileChanges("/repo", "/repo/x.ts", throwing), {
    reverted: false,
    code: "failed",
    error: "offline",
  });
});

test("an ok reply that did not say it reverted is not a success", async () => {
  const { revertGitFileChanges } = await loadSubject();
  const { fetchImpl } = fakeFetch(json(200, {}));

  const outcome = await revertGitFileChanges("/repo", "/repo/x.ts", fetchImpl);
  assert.equal(outcome.reverted, false);
  assert.equal(outcome.code, "failed");
});
