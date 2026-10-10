import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSnapshotLineSpan, readSnapshotOfCall } = await jiti.import("./read-snapshot.ts");

/** A completed `read` of lines 40-41 of a file, pi's own wording. */
const call = (input, text = "first line\nsecond line", overrides = {}) => ({
  toolName: "read",
  input,
  resultText: text,
  ...overrides,
});

test("a read call's whole text becomes the snapshot, pi's note dropped", () => {
  assert.deepEqual(
    readSnapshotOfCall(call({ path: "/tmp/a.ts" })),
    { filePath: "/tmp/a.ts", content: "first line\nsecond line" },
  );
  // The continuation notice is addressed to the model; the file has no such line.
  for (const note of [
    "\n\n[Showing lines 40-41 of 90. Use offset=42 to continue.]",
    "\n\n[Showing lines 40-41 of 90 (256KB limit). Use offset=42 to continue.]",
    "\n\n[49 more lines in file. Use offset=42 to continue.]",
  ]) {
    assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts" }, "first line\nsecond line" + note)).content, "first line\nsecond line");
  }
  // A line that only looks like the notice stays: it is in the file.
  const kept = "body\n[Showing lines are covered by the test suite]";
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.md" }, kept)).content, kept);
});

test("the read's offset carries over, and nothing else invents one", () => {
  assert.deepEqual(readSnapshotOfCall(call({ path: "/tmp/a.ts", offset: 40 })), { filePath: "/tmp/a.ts", content: "first line\nsecond line", offset: 40 });
  // Line 1 is where a whole file starts: no offset to carry.
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts", offset: 1 })).offset, undefined);
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts", offset: 0 })).offset, undefined);
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts", offset: "40" })).offset, undefined);
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts", offset: 1.5 })).offset, undefined);
  // MCP servers spell the same tool's input `file_path`.
  assert.deepEqual(readSnapshotOfCall(call({ file_path: "/tmp/a.ts", offset: 12 })), { filePath: "/tmp/a.ts", content: "first line\nsecond line", offset: 12 });
});

test("the card keeps its own body for anything the panel cannot show", () => {
  // Not a read.
  assert.equal(readSnapshotOfCall({ ...call({ path: "/tmp/a.ts" }), toolName: "bash" }), null);
  assert.equal(readSnapshotOfCall({ ...call({ path: "/tmp/a.ts" }), toolName: "write" }), null);
  // No result yet (still running), and a result that failed.
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts" }, null)), null);
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts" }, "boom", { isError: true })), null);
  // An image result: the card renders it, the panel has no text to show.
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/logo.png" }, "…", { hasImages: true })), null);
  // Streamed input is incomplete JSON.
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.ts" }, "…", { streamingInput: true })), null);
  // Nothing to read: an empty file, or a slice of blank lines. The card says
  // "(no output)"; an empty tab would say nothing at all.
  assert.equal(readSnapshotOfCall(call({ path: "/tmp/a.txt" }, "\n   \n")), null);
  // No path in the input: nothing to name the tab, and nothing to be sure of.
  assert.equal(readSnapshotOfCall(call({})), null);
  assert.equal(readSnapshotOfCall(call({ path: "  " })), null);
  assert.equal(readSnapshotOfCall({ toolName: "read", input: null, resultText: "text" }), null);
});

test("read matches the names decorated forms of pi's tool go by", () => {
  for (const toolName of ["read", "READ", "read_file", "mcp__files__read", "server.read"]) {
    assert.notEqual(readSnapshotOfCall({ ...call({ path: "/tmp/a.ts" }), toolName }), null, toolName);
  }
  // A tool that merely starts with the word is not it.
  assert.equal(readSnapshotOfCall({ ...call({ path: "/tmp/a.ts" }), toolName: "readme_print" }), null);
});

test("a snapshot's line span counts the file's lines, not the slice's", () => {
  assert.deepEqual(readSnapshotLineSpan({ content: "a\nb\nc" }), { from: 1, to: 3 });
  assert.deepEqual(readSnapshotLineSpan({ content: "a\nb\nc", offset: 40 }), { from: 40, to: 42 });
  // The last break ends the last line rather than opening another.
  assert.deepEqual(readSnapshotLineSpan({ content: "a\nb\n", offset: 40 }), { from: 40, to: 41 });
  assert.deepEqual(readSnapshotLineSpan({ content: "a", offset: 7 }), { from: 7, to: 7 });
  // A quoted field holding line breaks is still the lines the file has.
  assert.deepEqual(readSnapshotLineSpan({ content: "a,\"x\ny\"\nb", offset: 10 }), { from: 10, to: 12 });
});
