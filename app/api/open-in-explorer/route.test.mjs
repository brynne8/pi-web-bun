import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function reveal(revealFile, host = "localhost:30141") {
  return POST(new Request("http://localhost/api/open-in-explorer", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ revealFile }),
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

test("refuses a reveal outside the allowed roots before looking at it", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const response = await reveal(path.join(outside, "notes.md"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "access-denied" });
});

// A file that is allowed would really raise a Finder window on this machine, so
// what is checked here is every answer the route gives before it spawns: a
// reveal names one file, and a directory is not one. The command each platform
// gets is pinned in lib/open-in-file-manager.test.mjs instead.
test("refuses to reveal a directory, which is what opening a folder is for", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-open-in-explorer-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  allowFileRoot(root);
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "file.ts"), "export const a = 1;\n");

  const response = await reveal(path.join(root, "folder"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "not-a-file" });
});
