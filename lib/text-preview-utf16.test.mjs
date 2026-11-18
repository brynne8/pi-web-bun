import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readTextPreviewChunk } from "./text-preview.ts";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types.ts";

for (const endian of ["le", "be"]) {
  test(`UTF-16${endian} preview decodes its BOM and preserves paginated characters`, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "pi-web-utf16-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "notes.txt");
    for (const content of ["你好 😀\n", "x".repeat(TEXT_PREVIEW_MAX_BYTES / 2 - 2) + "😀\uFEFFtail"]) {
      const bytes = Buffer.from("\uFEFF" + content, "utf16le");
      if (endian === "be") bytes.swap16();
      writeFileSync(file, bytes);
      let offset = 0;
      let actual = "";
      do {
        const chunk = readTextPreviewChunk(file, bytes.length, offset);
        assert.equal(chunk.binary, false);
        assert.ok(chunk.nextOffset > offset);
        assert.equal(chunk.content.includes("\uFFFD"), false);
        actual += chunk.content;
        offset = chunk.nextOffset;
        assert.equal(chunk.truncated, offset < bytes.length);
      } while (offset < bytes.length);
      assert.equal(actual, content);
    }
  });
}
