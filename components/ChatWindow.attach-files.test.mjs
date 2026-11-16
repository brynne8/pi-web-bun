import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dropMentionText, splitDroppedItems, uploadDroppedFiles } from "../lib/file-upload-client.ts";

const chatWindow = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log", { type: "" });

/** Picks files with the composer's attach button, through the chat drop path. */
async function attach(files, { cwd = "/project", response } = {}) {
  const calls = { images: [], uploads: [], mentions: [], notices: [], refreshed: 0 };
  const items = files.map((file) => ({ kind: "file", file }));
  // The chat's drop path: images to the composer, and the rest to the upload.
  const { images, files: others } = splitDroppedItems(items);
  calls.images.push(...images);
  if (others.length === 0) return calls;
  await uploadDroppedFiles(others, {
    cwd,
    uploadFiles: async (target, uploads, strategy) => {
      calls.uploads.push([target, uploads.map((file) => file.name), strategy]);
      return { ...response, status: response.status, data: response.data };
    },
    dropMentionText,
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    insertText: (text) => calls.mentions.push(text),
    onFilesUploaded: () => { calls.refreshed += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("the attach button sends picked files down the chat drop path (#1101)", async () => {
  const mixed = await attach([photo, report, log], {
    response: { status: 207, data: { uploaded: ["report.pdf"], skipped: ["server.log"] } },
  });
  // Images attach to the prompt; the rest are uploaded like a drop: never replacing a file, then mentioned.
  assert.deepEqual(mixed.images, [photo]);
  assert.deepEqual(mixed.uploads, [["/project", ["report.pdf", "server.log"], "skip"]]);
  assert.deepEqual(mixed.mentions, ["@report.pdf @server.log "]);
  assert.deepEqual(mixed.notices, [
    ["success", 'chat.dropUploaded {"count":1}'],
    ["warning", 'chat.dropAlreadyExists {"names":"server.log"}'],
  ]);
  assert.equal(mixed.refreshed, 1);

  const imagesOnly = await attach([photo]);
  assert.deepEqual(imagesOnly.images, [photo]);
  assert.deepEqual(imagesOnly.uploads, []);
  assert.deepEqual(imagesOnly.notices, []);
});

test("without a working directory, picked files behave like a drop there (#1101)", async () => {
  const calls = await attach([photo, report], { cwd: null });
  assert.deepEqual(calls.images, [photo]);
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.notices, [["warning", "chat.dropNeedsCwd"]]);
});

test("the composer's attach button takes the chat's own drop path", () => {
  // `attach()` above plays the drop path itself, so the wiring from the picker into it is
  // what these two links carry: ChatInput gets `onAttachFiles`, and that callback hands its
  // files to `onDrop` — the callback that sends images to the composer and the rest up.
  assert.match(chatWindow, /onAttachFiles=\{onAttachFiles\}/);
  assert.match(chatWindow, /const onAttachFiles = useCallback\(\(files: File\[\]\) => \{\s*onDrop\(files\.map\(\(file\) => \(\{ kind: "file", file \}\)\)\);/);
  assert.match(chatWindow, /const onDrop = useCallback\(\(items: DroppedItem\[\]\) => \{[\s\S]{0,200}?chatInputRef\?\.current\?\.addImages\(images\)/);
});
