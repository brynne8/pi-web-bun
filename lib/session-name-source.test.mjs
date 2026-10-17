import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  SESSION_NAME_SOURCE_TYPE,
  appendSessionNameSource,
  autoNameDeclines,
  readSessionNameRecord,
} = await createJiti(import.meta.url).import("./session-name-source.ts");

function nameEntry(name, id = Math.random().toString(16)) {
  return { type: "session_info", name, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };
}

function sourceEntry(name, source, customType = SESSION_NAME_SOURCE_TYPE) {
  return {
    type: "custom",
    customType,
    data: { version: 1, name, source },
    id: Math.random().toString(16),
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

test("a session without a name has nothing for auto-naming to protect", () => {
  const record = readSessionNameRecord([sourceEntry("", "user")]);
  assert.deepEqual(record, { name: undefined, source: "unknown" });
  assert.equal(autoNameDeclines(record), false);
});

test("a name a person set is recognised and protected", () => {
  const record = readSessionNameRecord([nameEntry("My own title"), sourceEntry("My own title", "user")]);
  assert.deepEqual(record, { name: "My own title", source: "user" });
  assert.equal(autoNameDeclines(record), true);
});

test("a name auto-naming wrote stays fair game", () => {
  const record = readSessionNameRecord([nameEntry("Generated title"), sourceEntry("Generated title", "auto")]);
  assert.deepEqual(record, { name: "Generated title", source: "auto" });
  assert.equal(autoNameDeclines(record), false);
});

test("a name that changed after the record keeps no provenance and is protected", () => {
  const entries = [
    nameEntry("First"),
    sourceEntry("First", "auto"),
    nameEntry("Renamed in the pi TUI"),
  ];
  const record = readSessionNameRecord(entries);
  assert.deepEqual(record, { name: "Renamed in the pi TUI", source: "unknown" });
  assert.equal(autoNameDeclines(record), true);
});

test("an empty name clears the title and stops protecting it", () => {
  const entries = [nameEntry("Named"), sourceEntry("Named", "user"), nameEntry("")];
  assert.deepEqual(readSessionNameRecord(entries), { name: undefined, source: "unknown" });
});

test("another extension's entry and a malformed record are not provenance", () => {
  const entries = [
    nameEntry("Named"),
    sourceEntry("Named", "auto", "other-extension"),
    { type: "custom", customType: SESSION_NAME_SOURCE_TYPE, data: { version: 2, name: "Named", source: "user" } },
  ];
  assert.equal(readSessionNameRecord(entries).source, "unknown");
});

test("recording writes the versioned entry under the stored name", () => {
  const calls = [];
  appendSessionNameSource({ appendCustomEntry: (...args) => calls.push(args) }, "Two\nlines ", "user");
  assert.deepEqual(calls, [[SESSION_NAME_SOURCE_TYPE, { version: 1, name: "Two lines", source: "user" }]]);
});
