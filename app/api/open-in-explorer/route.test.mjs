import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

test.after(() => rm(agentDir, { recursive: true, force: true }));

function open(cwd, host = "localhost:30141") {
  return POST(new Request("http://localhost/api/open-in-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ cwd }),
  }));
}

function reveal(entry, host = "localhost:30141") {
  return POST(new Request("http://localhost/api/open-in-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ reveal: entry }),
  }));
}

const { allowFileRoot } = await jiti.import("@/lib/allowed-roots.ts");

test("rejects a path outside the allowed roots before looking at it", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));

  // Existing and missing paths answer the same, so the route is no existence oracle.
  for (const cwd of [outside, path.join(outside, "missing")]) {
    const response = await open(cwd);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "access-denied" });
  }
});

test("refuses requests that are not addressed to this machine", async () => {
  const response = await open(os.tmpdir(), "192.168.1.20:30141");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "remote" });
});

test("a reveal is checked against the allowed roots as an open is", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const response = await reveal(path.join(outside, "notes.md"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "access-denied" });
});

// A path that would really be opened raises a Finder or Explorer window on this
// machine, so what is checked here is every answer the route gives before it
// spawns. Which command a reveal builds is pinned in
// lib/open-in-file-manager.test.mjs (`fileManagerRevealCommand`).
test("refuses to open a file as a folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  allowFileRoot(root);
  await writeFile(path.join(root, "file.ts"), "export const a = 1;\n");

  const response = await open(path.join(root, "file.ts"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "not-a-directory" });
});
