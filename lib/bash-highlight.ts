/**
 * Shell-command highlighting for the chat tool cards.
 *
 * A scanner, not a shell grammar: it recognizes only what reads at a glance —
 * the command word, flags, quoted spans, expansions, operators and comments —
 * so a card can highlight its command on every render. The result is plain
 * tokens rather than markup, which keeps highlighting independent of the
 * element it renders into (a one-line card header as much as a `pre`).
 */

export type BashTokenKind =
  | "plain"
  | "command"
  | "flag"
  | "string"
  | "variable"
  | "operator"
  | "comment";

export interface BashToken {
  kind: BashTokenKind;
  text: string;
}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);
const OPERATOR_CHARS = "|&;<>{}()";
const DELIMITERS = new Set([...WHITESPACE, "'", '"', "`", "$", "\\", ...OPERATOR_CHARS]);
/** Characters a `$` may expand. */
const EXPANSION_START = /[A-Za-z0-9_?!@*$#]/;
/** Reserved words after which the next word runs a command, not an argument. */
const COMMAND_KEYWORDS = new Set(["then", "do", "else", "elif", "!"]);
const FLAG = /^-{1,2}[^\d\s]/;
/** The literal word of a `<<WORD` delimiter, scanned from `lastIndex`. */
const HEREDOC_DELIMITER = /[^\s"'`\\|&;<>(){}]+/y;

function findLineEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline;
}

function findClosingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") {
      depth += 1;
    } else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[\w]/.test(char);
}

/** The end of the `$…` expansion at `start`, or -1 when there is none. */
function expansionEnd(text: string, start: number): number {
  const next = text[start + 1];
  if (next === "{") {
    const end = text.indexOf("}", start + 2);
    return end === -1 ? text.length : end + 1;
  }
  if (next === "(") return findClosingParen(text, start + 1);
  if (next === undefined || !EXPANSION_START.test(next)) return -1;
  let end = start + 2;
  while (isNameChar(text[end])) end += 1;
  return end;
}

/**
 * A quoted span, up to and including the closing quote (or the end of the
 * command). Inside `"…"` an expansion is pushed separately so it keeps its own
 * colour; a backtick span is one substitution.
 */
function scanQuotes(
  text: string,
  start: number,
  quote: '"' | "`",
  push: (kind: BashTokenKind, value: string) => void,
): number {
  const kind: BashTokenKind = quote === '"' ? "string" : "variable";
  let index = start + 1;
  let chunk = start;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === "\\") {
      index += quote === '"' ? 2 : 1;
    } else if (quote === '"' && text[index] === "$" && expansionEnd(text, index) !== -1) {
      push("string", text.slice(chunk, index));
      const end = expansionEnd(text, index);
      push("variable", text.slice(index, end));
      index = end;
      chunk = index;
    } else {
      index += 1;
    }
  }
  const stop = Math.min(index + 1, text.length);
  push(kind, text.slice(chunk, stop));
  return stop;
}

/** A `<<WORD` redirect waiting for the body that follows its line. */
interface HeredocRedirect {
  /** The literal text that closes the body on a line of its own. */
  delimiter: string;
  /** False for a quoted delimiter (`<<'PY'`): the body is literal text. */
  expands: boolean;
  /** `<<-` strips a closing delimiter's leading tabs, nothing else. */
  stripTabs: boolean;
}

/**
 * The `<<WORD` redirect at `start`: where it ends and what closes its body.
 * Null for a here-string (`<<<`), and for a delimiter the shell would compute
 * (`<<$NAME`, backquoted) — its text cannot be matched, so the body is left
 * to the ordinary scan rather than guessed at.
 */
function scanHeredocRedirect(
  text: string,
  start: number,
): { end: number; redirect: HeredocRedirect } | null {
  if (text[start] !== "<" || text[start + 1] !== "<" || text[start + 2] === "<") return null;
  let index = start + 2;
  const stripTabs = text[index] === "-";
  if (stripTabs) index += 1;
  while (text[index] === " " || text[index] === "\t") index += 1;
  const quote = text[index];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, index + 1);
    if (close === -1) return null;
    return {
      end: close + 1,
      redirect: { delimiter: text.slice(index + 1, close), expands: false, stripTabs },
    };
  }
  // `<<\EOF` quotes the delimiter the same way; a backtick or `$` leaves it
  // computed, which is the case this scanner gives up on.
  const escaped = quote === "\\";
  if (escaped) index += 1;
  else if (quote === "`" || quote === "$") return null;
  HEREDOC_DELIMITER.lastIndex = index;
  const word = HEREDOC_DELIMITER.exec(text);
  if (!word) return null;
  return {
    end: index + word[0].length,
    redirect: { delimiter: word[0], expands: !escaped, stripTabs },
  };
}

/**
 * End of the heredoc opened at `start` (the first line whose whole content is
 * `delimiter`), or the end of the command when no line closes it.
 */
function findHeredocEnd(text: string, start: number, redirect: HeredocRedirect): number {
  let lineStart = start;
  while (lineStart < text.length) {
    const lineEnd = findLineEnd(text, lineStart);
    let content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (redirect.stripTabs) content = content.replace(/^\t+/, "");
    if (content === redirect.delimiter) return lineEnd;
    if (lineEnd === text.length) return text.length;
    lineStart = lineEnd + 1;
  }
  return text.length;
}

/**
 * A heredoc body as literal text: it is data, so no word in it is a command,
 * flag or comment. Only the expansions an unquoted delimiter still performs
 * take a colour, and a quoted one suppresses even those.
 */
function pushHeredocBody(
  text: string,
  start: number,
  end: number,
  redirect: HeredocRedirect,
  push: (kind: BashTokenKind, value: string) => void,
): void {
  if (!redirect.expands) {
    push("plain", text.slice(start, end));
    return;
  }
  let chunk = start;
  let index = start;
  while (index < end) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    let stop = -1;
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      stop = close !== -1 && close < end ? close + 1 : -1;
    } else if (char === "$") {
      const candidate = expansionEnd(text, index);
      stop = candidate !== -1 && candidate <= end ? candidate : -1;
    }
    if (stop === -1) {
      index += 1;
      continue;
    }
    push("plain", text.slice(chunk, index));
    push("variable", text.slice(index, stop));
    index = stop;
    chunk = stop;
  }
  push("plain", text.slice(chunk, end));
}

/**
 * `command` split into tokens, cut at `limit` characters for a one-line
 * preview. The kept pieces concatenate back to the command.
 */
export function tokenizeBash(command: string, limit = Number.POSITIVE_INFINITY): BashToken[] {
  const tokens: BashToken[] = [];
  let length = 0;
  let index = 0;
  // The first word of a line, and of a `|`, `&&`, `;` or subshell group, runs a
  // command; every other word is an argument.
  let expectCommand = true;
  let atWordStart = true;
  // Redirects seen on the current line, in the order their bodies follow it.
  const heredocs: HeredocRedirect[] = [];

  function push(kind: BashTokenKind, text: string): void {
    const kept = text.slice(0, Math.max(0, limit - length));
    if (!kept) return;
    length += kept.length;
    tokens.push({ kind, text: kept });
  }

  while (index < command.length && length < limit) {
    const char = command[index];

    if (WHITESPACE.has(char)) {
      const start = index;
      while (index < command.length && WHITESPACE.has(command[index])) {
        // A pending heredoc's body starts at the first newline of the line.
        if (heredocs.length > 0 && command[index] === "\n") {
          index += 1;
          break;
        }
        index += 1;
      }
      const run = command.slice(start, index);
      push("plain", run);
      atWordStart = true;
      if (run.includes("\n")) expectCommand = true;
      if (heredocs.length > 0 && run.endsWith("\n")) {
        const redirect = heredocs.shift()!;
        const end = findHeredocEnd(command, index, redirect);
        pushHeredocBody(command, index, end, redirect, push);
        index = end;
      }
      continue;
    }

    if (char === "\\") {
      const stop = Math.min(index + 2, command.length);
      push("plain", command.slice(index, stop));
      index = stop;
      atWordStart = false;
      continue;
    }

    // `#` starts a comment only at the start of a word; the word scan never
    // breaks on it, as in the shell itself.
    if (char === "#" && atWordStart) {
      const end = findLineEnd(command, index);
      push("comment", command.slice(index, end));
      index = end;
      continue;
    }

    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      const stop = end === -1 ? command.length : end + 1;
      push("string", command.slice(index, stop));
      index = stop;
      atWordStart = false;
      continue;
    }

    if (char === '"' || char === "`") {
      const stop = scanQuotes(command, index, char, push);
      index = stop;
      atWordStart = false;
      continue;
    }

    if (char === "$") {
      const end = expansionEnd(command, index);
      push(end === -1 ? "plain" : "variable", end === -1 ? "$" : command.slice(index, end));
      index = end === -1 ? index + 1 : end;
      atWordStart = false;
      continue;
    }

    // A heredoc redirect: its delimiter is an argument, and the line after it
    // is the body rather than more commands.
    if (char === "<") {
      const redirect = scanHeredocRedirect(command, index);
      if (redirect) {
        const operatorEnd = command[index + 2] === "-" ? index + 3 : index + 2;
        push("operator", command.slice(index, operatorEnd));
        // The gap before the delimiter is ordinary space, not part of it.
        let gap = operatorEnd;
        while (command[gap] === " " || command[gap] === "\t") gap += 1;
        push("plain", command.slice(operatorEnd, gap));
        push("string", command.slice(gap, redirect.end));
        index = redirect.end;
        heredocs.push(redirect.redirect);
        expectCommand = false;
        atWordStart = true;
        continue;
      }
    }

    if (OPERATOR_CHARS.includes(char)) {
      const start = index;
      while (index < command.length && OPERATOR_CHARS.includes(command[index])) index += 1;
      const run = command.slice(start, index);
      push("operator", run);
      // A redirection is followed by a file or a descriptor (`2>&1`), not by
      // another command; a subshell group (`<(`, `{`) starts one.
      expectCommand = run.includes("(") || run.includes("{")
        || (!run.includes(">") && !run.includes("<"));
      atWordStart = true;
      continue;
    }

    const start = index;
    while (index < command.length && !DELIMITERS.has(command[index])) index += 1;
    const word = command.slice(start, index);
    // A leading `NAME=value` assignment configures the command that follows;
    // it does not take the command slot itself. Only the name gets a colour;
    // the value keeps the surrounding text colour so long paths stay readable.
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*=)(.*)$/.exec(word);
    if (assignment) {
      push("variable", assignment[1]);
      if (assignment[2]) push("plain", assignment[2]);
      atWordStart = false;
      continue;
    }
    const kind: BashTokenKind = FLAG.test(word)
      ? "flag"
      : expectCommand
        ? "command"
        : "plain";
    push(kind, word);
    atWordStart = false;
    expectCommand = kind === "command" && COMMAND_KEYWORDS.has(word);
  }

  return tokens;
}
