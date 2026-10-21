// Scanner behind lib/doc-comment-limit.test.mjs: the comment above a function or a
// variable, counted the way a reader counts it.
//
// This is test-only tooling — nothing in the product imports it. It reads TypeScript
// from devDependencies, which is why it lives under `lib/__fixtures__/` and never in a
// `.ts` the app can reach.
import { readFileSync } from "node:fs";
import ts from "typescript";

/** The cap on a comment's content lines, the number this repository agreed on. */
export const MAX_COMMENT_CONTENT_LINES = 5;

/**
 * Declarations whose leading comment is a comment *about* them: the four shapes a doc
 * comment sits on, plus both kinds of `const x = …`. Types, interfaces and their members
 * are absent — the agreement was about a function or a variable, not every name.
 */
const DOCUMENTED_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  // A comment above `const x = …` is leading trivia of the statement, so only one of these
  // two sees it: the inner declaration's trivia starts after `const`.
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.VariableDeclaration,
]);

/**
 * The comment lines a reader sees, with the comment's scaffolding gone. Dropped: the
 * opening `/**` and the closing `*\/` lines, and any line the `*` gutter or `//` leaves
 * empty — a blank separator carries no words. Everything else is one line, `@param` tags
 * included, and a `* … *\/` that closes on the text's own line loses that marker too.
 */
export function contentLinesOfComment(raw) {
  const lines = raw.split(/\r?\n/);
  const content = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && lines.length > 1 && /^\s*\/\*\*?$/.test(line)) continue;
    if (i === lines.length - 1 && /^\s*\*\/$/.test(line)) continue;
    const body = line
      .replace(/^\s*\/\/\s?/, "")
      .replace(/^\s*\/?\*+\/?\s?/, "")
      .replace(/\s*\*\/\s*$/, "")
      .trim();
    if (body === "") continue;
    content.push(body);
  }
  return content;
}

/**
 * Comment ranges in front of a declaration, consecutive `//` lines merged into the one
 * comment they are. Counting them separately would let the same words dodge the cap by
 * dropping the `/**` wrapper.
 */
function leadingComments(text, fullStart, tokenStart) {
  // `getLeadingCommentRanges` walks forward from the position it is handed, so it takes
  // `getFullStart()` — the start of the leading trivia. `getStart()` finds nothing at all.
  const ranges = ts.getLeadingCommentRanges(text, fullStart) ?? [];
  const groups = [];
  for (const range of ranges) {
    if (range.end > tokenStart) break;
    const raw = text.slice(range.pos, range.end);
    const previous = groups[groups.length - 1];
    const continuesPrevious =
      previous?.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      range.kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      text.slice(previous.end, range.pos).trim() === "";
    if (continuesPrevious) {
      previous.end = range.end;
      previous.raw += "\n" + raw;
    } else {
      groups.push({ kind: range.kind, pos: range.pos, end: range.end, raw });
    }
  }
  return groups;
}

/**
 * Every comment above a function or a variable that runs past the cap. `files` are
 * relative to the working directory, and `readFile` defaults to the real filesystem so a
 * test can hand this a virtual tree.
 */
export function findLongTopComments({ files, readFile }) {
  const read = readFile ?? ((file) => readFileSync(file, "utf8"));
  const found = [];
  for (const file of files) {
    const text = read(file);
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos) => ts.getLineAndCharacterOfPosition(sourceFile, pos).line;

    const visit = (node) => {
      if (DOCUMENTED_KINDS.has(node.kind)) {
        const tokenStart = node.getStart(sourceFile);
        const comments = leadingComments(text, node.getFullStart(), tokenStart);
        const comment = comments[comments.length - 1];
        // The comment is the declaration's own when its last line is straight above the
        // declaration's first. A blank line between them makes it a note about the file or
        // the section below, which is how a file's opening comment stays out — a header is
        // followed by a blank line or by imports. Glued to the first declaration it is that
        // declaration's comment even at line 1, or the cap would be one line higher away.
        const directlyAbove = comment !== undefined && lineOf(comment.end) === lineOf(tokenStart) - 1;
        if (directlyAbove) {
          const content = contentLinesOfComment(comment.raw);
          if (content.length > MAX_COMMENT_CONTENT_LINES) {
            found.push({
              file,
              line: lineOf(comment.pos) + 1,
              contentLines: content.length,
              firstLine: content[0],
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}
