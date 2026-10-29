import type { Root as HastRoot } from "hast";
import type { VFile } from "vfile";
import type { Options as ReactMarkdownOptions } from "react-markdown";

type RehypePlugins = ReactMarkdownOptions["rehypePlugins"];
type KatexPlugin = (options?: unknown) => (tree: HastRoot, file: VFile) => void;

const katexOptions = { throwOnError: false, strict: false };

let katexPlugin: KatexPlugin | null = null;
let katexLoading: Promise<void> | null = null;

/** The `rehype-katex` plugin, in a chunk of its own, fetched the first time a rendered block holds math. */
export function loadKatexPlugin(): Promise<void> {
  katexLoading ??= import("rehype-katex").then((module) => {
    katexPlugin = module.default as KatexPlugin;
  });
  return katexLoading;
}

export function katexPluginReady(): boolean {
  return katexPlugin !== null;
}

const katexVariants = new WeakMap<object, RehypePlugins>();

/**
 * `plugins` with KaTeX's transform in place of the waiting plugin, cached per
 * list: react-markdown re-parses when the array identity changes, so the
 * variants are built once and the swap is what re-renders a gated block.
 */
export function markdownRehypePluginsWithKatex(plugins: RehypePlugins): RehypePlugins {
  if (!katexPlugin || !plugins) return plugins;
  let withKatex = katexVariants.get(plugins);
  if (!withKatex) {
    withKatex = [...plugins.filter((plugin) => plugin !== rehypeKatexWhenLoaded), [katexPlugin, katexOptions]];
    katexVariants.set(plugins, withKatex);
  }
  return withKatex;
}

// The three class names `rehype-katex` renders, and the only ones it renders:
// `remark-math`'s inline `$…$` and flow `$$…$$`, and a ```math fence.
const mathClassNames = ["math-inline", "math-display", "language-math"];

function holdsMathElement(node: unknown): boolean {
  const className = (node as { properties?: { className?: unknown } }).properties?.className;
  if (Array.isArray(className) && className.some((name) => mathClassNames.includes(String(name)))) return true;
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) && children.some(holdsMathElement);
}

/**
 * `rehype-katex` as a rehype plugin that waits for its chunk: the transform is
 * applied once it has been fetched, and fetching it starts here when the tree
 * holds a math element. A tree without one renders as it did before.
 */
export function rehypeKatexWhenLoaded() {
  return (tree: HastRoot, file: VFile): void => {
    // The loader is reached from a render, not from a module every session
    // evaluates, so a page with no math never fetches the chunk. A renderer
    // with a gate of its own (MarkdownBody) swaps in the transform instead,
    // through markdownRehypePluginsWithKatex().
    if (katexPlugin) {
      katexPlugin(katexOptions)(tree, file);
      return;
    }
    if (holdsMathElement(tree)) void loadKatexPlugin();
  };
}

// After `normalizeDisplayMath()` every math delimiter in the text is a `$`:
// `\(…\)` and `\[…\]` are rewritten to `$…$` and `$$…$$`, and a bare `[ … ]`
// line holding a formula to `$$…$$`. A ```math fence is the one form that
// carries no dollar, and a hand-written `class="math-inline"` survives the
// sanitizer, so both are matched as written.
const mathFencePattern = /(?:`{3,}|~{3,})[ \t]*math\b/;
const mathClassPattern = /\b(?:language-math|math-inline|math-display)\b/;

/** Whether a rendered text can hold a math node: the gate that keeps KaTeX out of the first-load graph. */
export function hasMathDelimiter(markdown: string): boolean {
  return markdown.includes("$") || mathFencePattern.test(markdown) || mathClassPattern.test(markdown);
}
