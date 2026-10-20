import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");
const { readTextPreviewChunk } = await jiti.import("./text-preview.ts");
const { getReadableFileSize } = await jiti.import("./text-preview.ts");

test("a short read is the file end, not a truncation", (t) => {
  // A transparent encryption filter driver (corporate DLP) hands statSync the
  // ciphertext length while its own reads return plaintext and stop at the
  // plaintext end. The whole file is loaded, so a caller that trusts the
  // metadata alone calls it truncated and drops the Markdown Preview tab.
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "encrypted.md");
  const content = "# 标题\r\n\r\n- 第一行\r\n";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const chunk = readTextPreviewChunk(filePath, size + 16384, 0);

  assert.equal(chunk.content, content);
  assert.equal(chunk.truncated, false);
  assert.equal(chunk.nextOffset, size);
  // The size the loaded content reaches is what the viewer shows as the total.
  assert.equal(chunk.size, size);
});

test("a whole small file reports its own size", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "small.md");
  writeFileSync(filePath, "hello\n");

  const chunk = readTextPreviewChunk(filePath, statSync(filePath).size, 0);

  assert.equal(chunk.truncated, false);
  assert.equal(chunk.size, 6);
});

test("a size past the chunk cap keeps the real total", (t) => {
  // The short-read rule must not swallow the "Load more" case: a chunk that
  // stops at the cap is genuinely partial, so the file keeps its full size.
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "capped.txt");
  writeFileSync(filePath, "a".repeat(TEXT_PREVIEW_MAX_BYTES + 1000));
  const size = statSync(filePath).size;

  const chunk = readTextPreviewChunk(filePath, size, 0);

  assert.equal(chunk.truncated, true);
  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.size, size);
});

test("a request past the readable end reports that end", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "past-end.txt");
  writeFileSync(filePath, "short\n");

  const chunk = readTextPreviewChunk(filePath, statSync(filePath).size + 16384, 6);

  assert.equal(chunk.content, "");
  assert.equal(chunk.truncated, false);
  assert.equal(chunk.size, 6);
});

test("the readable size is the size a stream can produce", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "plain.bin");
  writeFileSync(filePath, Buffer.alloc(1000, 0x41));

  assert.equal(getReadableFileSize(filePath, 1000), 1000);
  // The encryption driver's stat size, with reads that stop at the real end.
  assert.equal(getReadableFileSize(filePath, 1000 + 16384), 1000);
  assert.equal(getReadableFileSize(filePath, 0), 0);
  // A file that cannot be opened keeps the reported size rather than 0.
  assert.equal(getReadableFileSize(path.join(directory, "gone.bin"), 1234), 1234);
});

test("reads large text in contiguous UTF-8 chunks", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "large.txt");
  const content = "a".repeat(TEXT_PREVIEW_MAX_BYTES - 1) + "😀tail";
  writeFileSync(filePath, content);
  const size = statSync(filePath).size;

  const first = readTextPreviewChunk(filePath, size, 0);
  const second = readTextPreviewChunk(filePath, size, first.nextOffset);

  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, TEXT_PREVIEW_MAX_BYTES - 1);
  assert.equal(second.truncated, false);
  assert.equal(first.content + second.content, content);
  assert.equal(second.nextOffset, size);
});

test("invalid UTF-8 cannot stall pagination", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-web-text-preview-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "binary.txt");
  writeFileSync(filePath, Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1, 0x80));

  const chunk = readTextPreviewChunk(filePath, TEXT_PREVIEW_MAX_BYTES + 1, 0);

  assert.equal(chunk.nextOffset, TEXT_PREVIEW_MAX_BYTES);
  assert.equal(chunk.truncated, true);
});
