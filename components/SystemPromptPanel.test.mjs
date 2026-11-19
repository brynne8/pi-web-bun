import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import ts from "typescript";
import vm from "node:vm";

const source = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");

test("prompt entities unfold once, never twice", () => {
  const declaration = source.slice(
    source.indexOf("const promptEntities"),
    source.indexOf("export function SystemPromptPanel"),
  );
  const code = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const decode = vm.runInNewContext(`${code}; decodePromptEntities`);

  // What pi's escapeXml leaves behind in the skills block.
  assert.equal(decode(`<description>Triggers on &quot;add a transition&quot;.</description>`),
    `<description>Triggers on "add a transition".</description>`);
  assert.equal(decode("it&#39;s &lt;fine&gt; &amp; stable"), "it's <fine> & stable");

  // A source that already contained the literal entity text must survive one round, intact.
  assert.equal(decode("&amp;quot;"), "&quot;");
  assert.equal(decode("&amp;#39;"), "&#39;");

  // Unknown or malformed entities are left as written.
  assert.equal(decode("&nbsp; &#8212; &amp"), "&nbsp; &#8212; &amp");

  assert.equal(decode(""), "");
});
