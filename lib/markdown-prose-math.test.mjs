import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { VFile } from "vfile";

// Loaded through jiti, like the other Markdown tests: a source file imports its
// siblings without an extension, which Node's ESM loader cannot resolve.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { markdownRemarkPlugins, normalizeDisplayMath } = await jiti.import("./markdown.ts");
const {
  CJK_TEXT_MIN,
  SHELL_ENV_NAMES,
  demoteProseDisplayMath,
  hasCjkOnlyPunctuation,
  hasTooManyCjkLetters,
  isProseMathText,
  startsWithEnvName,
} = await jiti.import("./markdown-prose-math.ts");

// The app's own remark list, so these tests exercise the pairing refusal that
// markdownRemarkPlugins installs rather than a copy of it.
const processor = unified().use(remarkParse).use(markdownRemarkPlugins);

/** Inline and flow math left by the parse, plus the visible text. */
function parse(markdown) {
  const text = normalizeDisplayMath(markdown);
  const file = new VFile(text);
  const tree = processor.runSync(processor.parse(file), file);
  const inline = [];
  const flow = [];
  const words = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "inlineMath") inline.push(child.value);
      else if (child.type === "math") flow.push(child.value);
      else if (child.type === "text") words.push(child.value);
      else walk(child);
    }
  };
  walk(tree);
  return { inline, flow, text: words.join("") };
}

describe("startsWithEnvName", () => {
  it("names a shell variable", () => {
    for (const value of ["HOME", "HOME and ", " PATH ", "PATH=", "PORT=8080 和 ", "JAVA_HOME/x"]) {
      assert.equal(startsWithEnvName(value), true, value);
    }
  });

  it("does not name one for a prefix, a lowercase form or an unlisted name", () => {
    for (const value of ["PATHX", "PATHNAME", "home", "Path", "README", "HOST", "E=mc^2", "x"]) {
      assert.equal(startsWithEnvName(value), false, value);
    }
  });
});

describe("hasCjkOnlyPunctuation", () => {
  it("reads CJK-only marks as prose", () => {
    for (const value of ["a，b", "所以。", "为什么？", "重点：", "「重点」", "《论语》", "1、2", "１００％"]) {
      assert.equal(hasCjkOnlyPunctuation(value), true, value);
    }
  });

  it("ignores marks Latin text uses too, and the fullwidth dollar", () => {
    for (const value of ["x“这里”y", "a——b", "p…q", "a·b", "x’yy", "a-b", "a,b", "a＄b", "E=mc^2"]) {
      assert.equal(hasCjkOnlyPunctuation(value), false, value);
    }
  });
});

describe("hasTooManyCjkLetters", () => {
  it("counts up to the limit without deciding", () => {
    assert.equal(CJK_TEXT_MIN, 5);
    assert.equal(hasTooManyCjkLetters("速度 v"), false);
    assert.equal(hasTooManyCjkLetters("输入维度为 "), false); // exactly CJK_TEXT_MIN
    assert.equal(hasTooManyCjkLetters("总成本"), false);
  });

  it("reads a sentence of CJK letters as prose", () => {
    assert.equal(hasTooManyCjkLetters("模型输出概率分布"), true);
    assert.equal(hasTooManyCjkLetters("总损失函数为交叉熵"), true);
    assert.equal(hasTooManyCjkLetters("この変数は確率"), true);
    assert.equal(hasTooManyCjkLetters("이 변수는 확률값"), true);
  });

  it("does not count what a TeX command takes in braces", () => {
    assert.equal(hasTooManyCjkLetters("\\text{总损失函数为交叉熵}"), false);
    assert.equal(hasTooManyCjkLetters("\\text{输入维度为 } d"), false);
    assert.equal(hasTooManyCjkLetters("\\frac{模型输出概率分布}{x}"), false);
    // An environment's body is the formula's own characters, not an argument.
    assert.equal(hasTooManyCjkLetters("\\begin{pmatrix}中文中文中文中文\\end{pmatrix}"), true);
    // Outside the braces the count still applies.
    assert.equal(hasTooManyCjkLetters("\\alpha 模型输出概率分布"), true);
  });
});

describe("isProseMathText", () => {
  it("fires on any of the three rules", () => {
    for (const value of ["HOME and ", "PATH", "PORT=8080 和 ", "a，b", "「重点」", "模型输出概率分布"]) {
      assert.equal(isProseMathText(value), true, value);
    }
  });

  it("keeps every formula shape", () => {
    for (const value of [
      "E=mc^2", "PV=nRT", "AX=b", "AB", "R", "MSE", "SE", "DNA", "UV", "x y z", "速度 v", "总",
      "x + y", " x + y ", "x ", "2 + 2 = 4", "\\alpha", "x_i", "\\text{总损失函数为交叉熵}",
    ]) {
      assert.equal(isProseMathText(value), false, value);
    }
  });
});

describe("the pairing refusal", () => {
  it("keeps a shell-variable sentence out of math", () => {
    const { inline, text } = parse("echo $HOME and $PATH in the shell");
    assert.deepEqual(inline, []);
    assert.match(text, /echo \$HOME and \$PATH in the shell/);
  });

  it("costs the text after $HOME nothing: a later formula still pairs", () => {
    assert.deepEqual(parse("见 $HOME 和 $x + 1$ 两个").inline, ["x + 1"]);
    assert.deepEqual(parse("先输出 $HOME 再算 $2 + 2 = 4$").inline, ["2 + 2 = 4"]);
    assert.deepEqual(parse("输出 $HOME 与 $\\alpha$ 两值").inline, ["\\alpha"]);
    assert.deepEqual(parse("先 echo $HOME 再算 $x_i$").inline, ["x_i"]);
  });

  it("refuses an unlisted name as soon as it is a variable", () => {
    const { inline, text } = parse("配置 $PORT=8080 和 $HOST=localhost");
    assert.deepEqual(inline, []);
    assert.match(text, /\$PORT=8080/);
  });

  it("leaves a formula alone", () => {
    for (const [markdown, value] of [
      ["$E=mc^2$", "E=mc^2"],
      ["$PV=nRT$", "PV=nRT"],
      ["$AX=b$", "AX=b"],
      ["$AB$ 两条线段", "AB"],
      ["$MSE$ 收敛", "MSE"],
      ["$速度 v$ 随时间", "速度 v"],
      ["$x y z$ 三个变量", "x y z"],
      ["$\\text{总损失函数为交叉熵}$", "\\text{总损失函数为交叉熵}"],
    ]) {
      const { inline, text } = parse(markdown);
      assert.deepEqual(inline, [value], markdown);
      assert.doesNotMatch(text, /\$/, markdown);
    }
  });

  it("refuses CJK punctuation but not a Latin quote, dash or ellipsis", () => {
    assert.deepEqual(parse("这里 $a，b$ 两个数").inline, []);
    assert.deepEqual(parse("引号不算：$x$“这里”$y$").inline, ["x", "y"]);
    assert.deepEqual(parse("破折号不算：$a$——$b$").inline, ["a", "b"]);
  });
});

describe("demoteProseDisplayMath", () => {
  it("turns a prose $$…$$ block back into its source", () => {
    const { flow, text } = parse("$$\nHOME and PATH\n$$\n");
    assert.deepEqual(flow, []);
    assert.match(text, /\$\$/);
  });

  it("leaves a real display block alone", () => {
    assert.deepEqual(parse("$$\nx + y\n$$\n").flow, ["x + y"]);
  });

  it("does nothing when the source text is missing", () => {
    const tree = processor.runSync(processor.parse(new VFile("$$\nHOME and PATH\n$$\n")));
    demoteProseDisplayMath(tree, "");
    const blocks = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (child.type === "math") blocks.push(child);
        else walk(child);
      }
    };
    walk(tree);
    assert.equal(blocks.length, 1);
  });
});

describe("SHELL_ENV_NAMES", () => {
  it("is a short, uppercase, unique list", () => {
    assert.deepEqual(SHELL_ENV_NAMES, [
      "HOME", "PATH", "PORT", "USER", "PWD", "OLDPWD", "SHELL", "TMPDIR", "LANG",
      "TERM", "EDITOR", "DISPLAY", "PYTHONPATH", "JAVA_HOME", "NODE_PATH", "GOPATH",
    ]);
    for (const name of SHELL_ENV_NAMES) assert.equal(name, name.toUpperCase());
    assert.equal(new Set(SHELL_ENV_NAMES).size, SHELL_ENV_NAMES.length);
  });
});
