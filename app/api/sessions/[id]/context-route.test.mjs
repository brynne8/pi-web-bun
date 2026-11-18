// What the chat reads before it paints: the default window and the page above it
// (app/api/sessions/[id]/context/route.ts). These assertions came out of e2e/run.mjs,
// where they ran on `fetch` against a live server and never touched the browser.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { resetSessionScanIndex } from "../../../../lib/__fixtures__/session-scan-index.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionContext } = await jiti.import("./context/route.ts");
const {
  invalidateSessionListCache,
  invalidateSessionPathCache,
} = await jiti.import("../../../../lib/session-reader.ts");

// The scan index and the path cache are module globals: under Bun this file shares
// them with every other file's listings, so start and end with an empty pair.
await resetSessionScanIndex();
after(resetSessionScanIndex);

const timestamp = "2026-08-23T00:00:00.000Z";
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-context-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
invalidateSessionListCache();
after(async () => {
  invalidateSessionListCache();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

async function writeSession(id, entries) {
  const sessionDir = join(agentDir, "sessions", "fixture");
  await mkdir(sessionDir, { recursive: true });
  const header = { type: "session", version: 3, id, timestamp, cwd: agentDir };
  await writeFile(
    join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`),
    `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  invalidateSessionPathCache(id);
  invalidateSessionListCache();
}

const context = (id) => ({ params: Promise.resolve({ id }) });

async function read(id, query = "") {
  const response = await getSessionContext(
    new Request(`http://localhost/api/sessions/${id}/context${query}`),
    context(id),
  );
  assert.equal(response.status, 200, `GET /context${query} -> ${response.status}`);
  return (await response.json()).context;
}

test("a branch read follows the named leaf and pages up to the root without repeating it", async () => {
  const id = "branch-session";
  await writeSession(id, [
    message("root", null, "user", "Branch root"),
    message("old", "root", "assistant", "Inactive branch answer"),
    message("new", "root", "assistant", "Active branch answer"),
  ]);

  assert.deepEqual((await read(id, "?leafId=old")).entryIds, ["root", "old"]);
  const rootPage = await read(id, "?before=old&tail=1");
  assert.deepEqual(rootPage.entryIds, ["root"]);
  assert.equal(rootPage.hasMore, false);
  const beforeRoot = await read(id, "?before=root");
  assert.deepEqual(beforeRoot.entryIds, []);
  assert.equal(beforeRoot.hasMore, false);
});

test("an unknown session id is a 404, not an empty page", async () => {
  const response = await getSessionContext(
    new Request("http://localhost/api/sessions/e2e-does-not-exist/context"),
    context("e2e-does-not-exist"),
  );
  assert.equal(response.status, 404);
});

test("the first page of a compacted session starts at the divider and holds no prompt above it", async () => {
  const id = "compacted-session";
  const entries = [
    message("user", null, "user", "Prompt outside the compacted page"),
    { type: "compaction", id: "compact", parentId: "user", timestamp, summary: "Compaction anchor", firstKeptEntryId: "user", tokensBefore: 100 },
  ];
  // Tool results ride along free, so 48 tool-call assistants, the final answer and
  // the divider fill the 50-message window and the prompt stays outside it.
  for (let i = 0; i < 48; i++) {
    entries.push(message(`call${i}`, entries.at(-1).id, "assistant", [
      { type: "toolCall", id: `t${i}`, name: "bash", arguments: { command: `echo step${i}` } },
    ]));
    const result = message(`result${i}`, `call${i}`, "toolResult", [{ type: "text", text: `step${i}` }]);
    Object.assign(result.message, { toolCallId: `t${i}`, toolName: "bash", isError: false });
    entries.push(result);
  }
  entries.push(message("answer", "result47", "assistant", [{ type: "text", text: "Compacted answer" }]));
  await writeSession(id, entries);

  const compacted = await read(id);
  assert.equal(compacted.entryIds[0], "compact");
  assert.equal(compacted.messages.some((entry) => entry.role === "user"), false);
});
