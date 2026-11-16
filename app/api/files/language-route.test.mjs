import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "vinext/shims/server";
import { createJiti } from "jiti";
import { refractor } from "refractor/all";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-files-language-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const { textPreviewExtensions } = await jiti.import("../../../lib/file-types.ts");
allowFileRoot(root);

// The map lives in lib/file-types.ts, not beside the route: the read panel
// works a slice's language out in the browser without the file ever being read.
const textExtensions = textPreviewExtensions();
assert.ok(textExtensions.includes("ts") && textExtensions.every(Boolean), "EXT_TO_LANGUAGE keys not read");

async function languageOf(name) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, "x\n");
  const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const response = await GET(
    new NextRequest("http://localhost/api/files/x?type=read"),
    { params: Promise.resolve({ path: segments }) },
  );
  assert.equal(response.status, 200, name);
  return (await response.json()).language;
}

test("every language a source file gets is a Prism grammar, or text", async () => {
  // PrismLight renders an unknown name as plain text, so a typo shows no error.
  const names = [...textExtensions.map((ext) => `sample.${ext}`), "Dockerfile", "Makefile", ".env.local"];
  for (const name of names) {
    const language = await languageOf(name);
    if (language !== "text") assert.equal(refractor.registered(language), true, `${name}: ${language}`);
  }
});

test("only HTML and Markdown files take a language that opens their Preview", async () => {
  const preview = [];
  for (const ext of textExtensions) {
    if (["html", "markdown"].includes(await languageOf(`sample.${ext}`))) preview.push(ext);
  }
  assert.deepEqual(preview.sort(), ["htm", "html", "md", "mdx"]);
  for (const ext of ["vue", "svelte", "astro"]) assert.equal(await languageOf(`App.${ext}`), "markup");
});

test("JSX gets its tags colored and an ambiguous extension stays plain", async () => {
  for (const name of ["App.tsx", "App.jsx"]) {
    const tree = refractor.highlight('const a = <a href="x">t</a>;', await languageOf(name));
    const classes = JSON.stringify(tree);
    assert.match(classes, /"tag"/, name);
    assert.match(classes, /"attr-name"/, name);
  }
  assert.equal(await languageOf("analysis.R"), "r");
  assert.equal(await languageOf("plot.m"), "text");
});

test("a binary file without a preview answers binary, never its bytes as text (#1401)", async () => {
  async function read(name, bytes) {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, bytes);
    const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    return GET(
      new NextRequest("http://localhost/api/files/x?type=read"),
      { params: Promise.resolve({ path: segments }) },
    );
  }
  const zip = await (await read("archive.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]))).json();
  assert.equal(zip.binary, true);
  assert.equal(zip.content, "");
  assert.equal(zip.size, 8);

  const text = await (await read("notes.unknownext", "plain\n")).json();
  assert.equal(text.binary, false);
  assert.equal(text.content, "plain\n");

  // Previewed media is streamed before any text sniffing.
  const png = await read("pixel.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  assert.equal(png.headers.get("content-type"), "image/png");
});
