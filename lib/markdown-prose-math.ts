/**
 * Which `$…$` is prose rather than a formula, decided while pairing.
 *
 * A single `$` becomes an opening delimiter as soon as another `$` appears
 * later, because the grammar says nothing about what may sit between them
 * (`math_text ::= sequence_text 1*byte sequence_text`). So a message about
 * shell variables loses its words to KaTeX: `echo $HOME and $PATH in the
 * shell` renders `HOME and ` in math italics.
 *
 * The rules below run at the pairing decision itself (see
 * `remarkNotMathPairs` in `lib/markdown.ts`), not on the parsed tree. That
 * placement is the whole point: refusing the pair means the opening `$` was
 * never a delimiter, so the text after it is scanned from there and pairs on
 * its own. Refusing after the parse would leave the closing `$` consumed and
 * take a following real formula down with it — `见 $HOME 和 $x + 1$ 两个`
 * would show no formula at all instead of `x + 1`.
 *
 * Three rules, each reading the content between the two dollars:
 *
 * 1. A shell variable name (`SHELL_ENV_NAMES`) at the start is never a
 *   formula, in any pairing. Matched on the name only: `$HOME and …` is
 *   refused and everything after `HOME` is parsed as usual.
 * 2. A punctuation mark that exists only in CJK text (`，。？：`, 「」, 《》)
 *   ends the argument: nothing TeX is written with those. Quotation marks
 *   `“”‘’`, dashes `–—`, the ellipsis `…` and the interpunct `·` are NOT in
 *   the list — Latin text uses the same characters, so they prove nothing.
 * 3. More than `CJK_TEXT_MIN` CJK letters is prose, so `$模型输出概率分布$`
 *   is text while `$速度 v$` (a quantity named in two characters) is still a
 *   formula. What a TeX command takes in braces is its argument, not the
 *   formula's own characters: all of `$\text{总损失函数为交叉熵}$` counts as
 *   zero CJK letters.
 *
 * Prices are decided by the same tokenizer guard, before any of this.
 *
 * One form cannot be refused at pairing time: a `$$…$$` block is a fence
 * decision, not a pair, so `remarkProseDisplayMath` below still reads the
 * parsed tree. A fence cannot take anything from a later formula, which is
 * exactly the damage the inline rules had to move out of.
 */

import type { Parent, Root } from "mdast";
import type { Plugin } from "unified";

/** Shell variable names no one writes as a formula. Matched case-sensitively. */
export const SHELL_ENV_NAMES = [
  "HOME", "PATH", "PORT", "USER", "PWD", "OLDPWD", "SHELL", "TMPDIR", "LANG",
  "TERM", "EDITOR", "DISPLAY", "PYTHONPATH", "JAVA_HOME", "NODE_PATH", "GOPATH",
] as const;

/** CJK letters above this count make the content prose. */
export const CJK_TEXT_MIN = 5;

// U+FF04 ＄ (fullwidth dollar) is left out of the punctuation list: a value
// carrying it is prose anyway, and a delimiter mark should not decide anything.
const CJK_ONLY_PUNCTUATION = new RegExp(
  [
    "[\\u3000-\\u3003]", // ideographic space, 、 。 〃
    "[\\u3008-\\u3011]", // 〈〉《》「」『』【】
    "[\\u3014-\\u301F]", // 〔〕〖〗〘〙〚〛〝〞〟
    "[\\u30FB\\u30FC]", // ・ ー
    "[\\uFF01-\\uFF03\\uFF05-\\uFF65]", // ！＂＃ ％…～ ｠｡
    "[\\uFE10-\\uFE19\\uFE30-\\uFE4F]", // vertical and compatibility forms
  ].join("|"),
);

// Han (incl. Extension A and compatibility), Hiragana, Katakana (incl. the
// halfwidth and small blocks) and Hangul syllables. Astral-plane ideographs
// (Extension B and later) are not counted: they need surrogate handling for no
// gain over a ">5" rule.
const CJK_LETTER = new RegExp(
  [
    "[\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF]", // ideographs
    "[\\u3041-\\u3096\\u309D-\\u30FF\\u31F0-\\u31FF]", // Hiragana, small Katakana ext.
    "[\\u30A1-\\u30FA\\u30FC-\\u30FF]", // Katakana
    "[\\uFF66-\\uFF9F]", // halfwidth Katakana
    "[\\u1100-\\u11FF\\uAC00-\\uD7AF]", // Hangul
  ].join("|"),
  "g",
);

// `\text{…}`, `\frac{…}{…}`, `\begin{…}`: everything a command takes in
// braces is its argument. The repeated pass peels nested braces from the
// inside out, and stops as soon as one round removes nothing.
const COMMAND_ARGUMENT = /\\[A-Za-z]+\s*\{[^{}]*\}/g;

function withoutCommandArguments(value: string): string {
  let text = value;
  for (let round = 0; round < 8; round++) {
    const peeled = text.replace(COMMAND_ARGUMENT, "");
    if (peeled === text) break;
    text = peeled;
  }
  return text;
}

/** Rule 1: the content opens with a shell variable name. */
export function startsWithEnvName(value: string): boolean {
  const name = value.trimStart().match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
  return name !== undefined && (SHELL_ENV_NAMES as readonly string[]).includes(name);
}

/** Rule 2: the content holds punctuation only CJK text has. */
export function hasCjkOnlyPunctuation(value: string): boolean {
  return CJK_ONLY_PUNCTUATION.test(value);
}

/** Rule 3: the content carries more CJK letters than a formula would. */
export function hasTooManyCjkLetters(value: string): boolean {
  const letters = withoutCommandArguments(value).match(CJK_LETTER);
  return letters !== null && letters.length > CJK_TEXT_MIN;
}

/** Whether one `$…$` pair's content is prose rather than a formula. */
export function isProseMathText(value: string): boolean {
  return startsWithEnvName(value) || hasCjkOnlyPunctuation(value) || hasTooManyCjkLetters(value);
}

/**
 * Replaces a flow math block whose content is prose with the source text it
 * was parsed from, in place, so the `$$` come back as the author typed them.
 * `source` must be the markdown the tree came from. Inline math is not
 * examined here: `remarkNotMathPairs` already refused those pairs while
 * tokenizing, which is the only moment a refusal costs nothing to the text
 * after it.
 */
export function demoteProseDisplayMath(tree: Root, source: string): void {
  const walk = (parent: Root | Parent): void => {
    const children = parent.children;
    for (let index = 0; index < children.length; index++) {
      const node = children[index] as Root["children"][number] & { value?: string };
      if (node.type === "math" && typeof node.value === "string") {
        const from = node.position?.start?.offset;
        const to = node.position?.end?.offset;
        if (from == null || to == null || !isProseMathText(node.value)) continue;
        const raw = source.slice(from, to);
        if (!raw) continue;
        children[index] = { type: "text", value: raw } as never;
        continue;
      }
      if ("children" in node && Array.isArray(node.children)) walk(node as Parent);
    }
  };
  walk(tree);
}

/** The remark plugin for the one form pairing cannot refuse: `$$…$$`. */
export const remarkProseDisplayMath: Plugin = function () {
  return (tree, file) => {
    demoteProseDisplayMath(tree as Root, typeof file.value === "string" ? file.value : "");
  };
};
