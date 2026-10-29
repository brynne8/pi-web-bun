import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { markdownRehypePlugins, markdownPreviewRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } = await jiti.import("./markdown.ts");
const { hasMathDelimiter, katexPluginReady, loadKatexPlugin, markdownRehypePluginsWithKatex, rehypeKatexWhenLoaded } = await jiti.import("./markdown-katex.ts");

const katexOptions = { throwOnError: false, strict: false };

function render(markdown, rehypePlugins) {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: markdownRemarkPlugins,
    rehypePlugins,
  }, normalizeDisplayMath(markdown)));
}

// The gate: KaTeX renders only these three classes, so a text that can produce
// none of them renders byte for byte what the list excluding it renders.
test("a text that can hold no math renders as it does without the KaTeX plugin", () => {
  for (const markdown of [
    "Prices: \\$20 and \\$6. Code: `$20 + $6`. [Price](https://example.com/$20/$6)",
    "```text\n$20 + $6\n```",
    "| a | b |\n| --- | --- |\n| $20 | $6 |",
    "echo $HOME and $PATH in the shell",
  ]) {
    const html = render(markdown, markdownRehypePlugins);
    assert.doesNotMatch(html, /class="katex|math-inline|math-display/, markdown);
    assert.ok(html.includes("$"), markdown);
    assert.equal(html, render(markdown, markdownRehypePlugins.slice(0, -1)), markdown);
  }
});

test("every form a math delimiter takes is gated on", () => {
  for (const markdown of [
    "$x + y$",
    "$$\nx = 1\n$$",
    String.raw`\(r_c = K^{-1}p\)`,
    String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`,
    "[ C(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S_i ]",
    "```math\nx + y\n```",
    "~~~math\nx + y\n~~~",
    '<code class="math-inline">x + y</code>',
  ]) {
    assert.equal(hasMathDelimiter(normalizeDisplayMath(markdown)), true, markdown);
  }
  for (const markdown of ["plain prose", "今天天气很好。", "```js\nconst a = 1\n```", "| a | b |\n| --- | --- |"]) {
    assert.equal(hasMathDelimiter(markdown), false, markdown);
  }
});

test("math renders exactly as rehype-katex renders it once the chunk has landed", async () => {
  const markdown = [
    String.raw`射线为 \(r_c = K^{-1}p\)。`,
    "$$",
    String.raw`P(\lambda)=o_b+\lambda r_b`,
    "$$",
    String.raw`[ C(x) = \frac{2}{T} \sum_i S_i ]`,
    "```math",
    "x + y",
    "```",
  ].join("\n");
  const withoutKatex = render(markdown, markdownRehypePlugins.slice(0, -1));
  // The one frame before the chunk lands: the math is its source text.
  assert.match(withoutKatex, /<code class="language-math math-inline">r_c = K\^\{-1\}p<\/code>/);

  await loadKatexPlugin();
  assert.equal(katexPluginReady(), true);

  const withKatex = render(markdown, markdownRehypePlugins);
  assert.equal(
    withKatex,
    render(markdown, [...markdownRehypePlugins.slice(0, -1), [rehypeKatex, katexOptions]]),
  );
  assert.match(withKatex, /class="katex"/);
  assert.match(withKatex, /class="katex-display"/);
  assert.doesNotMatch(withKatex, /katex-error/);
});

test("the swap that carries the transform is cached and changes the list identity", async () => {
  await loadKatexPlugin();
  const swapped = markdownRehypePluginsWithKatex(markdownRehypePlugins);
  assert.notEqual(swapped, markdownRehypePlugins);
  assert.equal(markdownRehypePluginsWithKatex(markdownRehypePlugins), swapped);
  assert.deepEqual(swapped.at(-1), [rehypeKatex, katexOptions]);
  assert.ok(!swapped.includes(rehypeKatexWhenLoaded), "the waiting plugin gives way to the transform");
  const preview = markdownPreviewRehypePlugins;
  assert.notEqual(markdownRehypePluginsWithKatex(preview), preview);
  assert.equal(markdownRehypePluginsWithKatex(preview), markdownRehypePluginsWithKatex(preview));
});
