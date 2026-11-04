/**
 * Command output as styled runs: SGR colours and attributes become styles, and every
 * other escape (cursor moves, erases, osc without a link) is dropped rather than
 * printed. `lib/ansi.ts`'s `stripAnsi()` is the same question with a blunter answer —
 * this one keeps what a command's colours were telling you.
 */

export interface AnsiStyle {
  color?: string;
  background?: string;
  bold?: boolean;
  faint?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface AnsiRun {
  text: string;
  style?: AnsiStyle;
  /** An osc 8 hyperlink's target; only http(s) reaches the screen as a link. */
  href?: string;
}

/** What a terminal paints where the command set nothing. */
export const ANSI_DEFAULT_FG = "var(--ansi-fg, currentColor)";
export const ANSI_DEFAULT_BG = "var(--ansi-bg, rgba(128, 128, 128, 0.32))";

/**
 * The 16 base colours follow the theme through the `--ansi-*` tokens; the value
 * behind the comma is what a page without that stylesheet draws.
 */
const ANSI_16 = [
  "var(--ansi-0, rgb(110, 118, 129))",
  "var(--ansi-1, rgb(203, 71, 66))",
  "var(--ansi-2, rgb(35, 130, 85))",
  "var(--ansi-3, rgb(158, 116, 32))",
  "var(--ansi-4, rgb(64, 103, 214))",
  "var(--ansi-5, rgb(163, 71, 171))",
  "var(--ansi-6, rgb(35, 130, 146))",
  "var(--ansi-7, rgb(128, 134, 142))",
  "var(--ansi-8, rgb(110, 118, 129))",
  "var(--ansi-9, rgb(214, 82, 71))",
  "var(--ansi-10, rgb(46, 133, 88))",
  "var(--ansi-11, rgb(158, 116, 32))",
  "var(--ansi-12, rgb(86, 115, 222))",
  "var(--ansi-13, rgb(178, 90, 188))",
  "var(--ansi-14, rgb(46, 133, 148))",
  "var(--ansi-15, rgb(172, 177, 184))",
];

const SGR_RE = /^\x1b\[([0-9;:]*)m/;
const CSI_RE = /^\x1b\[[0-?]*[ -/]*[@-~]/;
const OSC_LINK_RE = /^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const ESC_RE = /^\x1b[@-Z\\-_]/;
/** An escape the stream has not finished writing, at the very end of the text. */
const PARTIAL_RE = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*|[0-9;]*)$/;

const LINK_PROTOCOLS = ["http://", "https://"];

interface AnsiState {
  color: string | null;
  background: string | null;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
}

function newState(): AnsiState {
  return {
    color: null,
    background: null,
    bold: false,
    faint: false,
    italic: false,
    underline: false,
    strike: false,
    inverse: false,
  };
}

/** An xterm 256-colour index as a CSS colour. The first 16 follow the theme. */
export function ansi256(index: number): string {
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const levels = [0, 95, 135, 175, 215, 255];
    const n = index - 16;
    const r = levels[Math.floor(n / 36)];
    const g = levels[Math.floor(n / 6) % 6];
    const b = levels[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

/** One `ESC [ … m` sequence's parameters, `;` and `:` both separating them. */
function applySgr(state: AnsiState, captured: string): void {
  const params = captured.split(/[;:]/).filter((p) => p !== "");
  if (params.length === 0) params.push("0");
  for (let i = 0; i < params.length; i++) {
    const num = Number(params[i]);
    if (Number.isNaN(num)) continue;
    if (num === 0) Object.assign(state, newState());
    else if (num === 1) state.bold = true;
    else if (num === 2) state.faint = true;
    else if (num === 3) state.italic = true;
    else if (num === 4) state.underline = true;
    else if (num === 7) state.inverse = true;
    else if (num === 9) state.strike = true;
    else if (num === 21 || num === 22) {
      state.bold = false;
      state.faint = false;
    }
    else if (num === 23) state.italic = false;
    else if (num === 24) state.underline = false;
    else if (num === 27) state.inverse = false;
    else if (num === 29) state.strike = false;
    else if (num === 39) state.color = null;
    else if (num === 49) state.background = null;
    else if (num >= 30 && num <= 37) state.color = ANSI_16[num - 30];
    else if (num >= 40 && num <= 47) state.background = ANSI_16[num - 40];
    else if (num >= 90 && num <= 97) state.color = ANSI_16[num - 90 + 8];
    else if (num >= 100 && num <= 107) state.background = ANSI_16[num - 100 + 8];
    else if (num === 38 || num === 48) {
      const mode = params[++i];
      if (mode === "5") {
        const index = Number(params[++i]);
        if (Number.isInteger(index) && index >= 0 && index <= 255) {
          if (num === 38) state.color = ansi256(index);
          else state.background = ansi256(index);
        } else {
          i--;
        }
      } else if (mode === "2") {
        const r = Number(params[++i]);
        const g = Number(params[++i]);
        const b = Number(params[++i]);
        const ok = [r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
        if (ok) {
          if (num === 38) state.color = `rgb(${r},${g},${b})`;
          else state.background = `rgb(${r},${g},${b})`;
        } else {
          i -= 3;
        }
      }
    }
  }
}

function styleOf(state: AnsiState): AnsiStyle | undefined {
  const style: AnsiStyle = {};
  // Inverse swaps the two: what the command left unset takes the terminal's own.
  const color = state.inverse ? state.background ?? ANSI_DEFAULT_BG : state.color;
  const background = state.inverse ? state.color ?? ANSI_DEFAULT_FG : state.background;
  if (color) style.color = color;
  if (background) style.background = background;
  if (state.bold) style.bold = true;
  if (state.faint) style.faint = true;
  if (state.italic) style.italic = true;
  if (state.underline) style.underline = true;
  if (state.strike) style.strike = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

function sameRun(a: AnsiRun, b: AnsiRun): boolean {
  if ((a.href ?? "") !== (b.href ?? "")) return false;
  const x: AnsiStyle = a.style ?? {};
  const y: AnsiStyle = b.style ?? {};
  return (
    x.color === y.color &&
    x.background === y.background &&
    x.bold === y.bold &&
    x.faint === y.faint &&
    x.italic === y.italic &&
    x.underline === y.underline &&
    x.strike === y.strike
  );
}

function pushRun(runs: AnsiRun[], run: AnsiRun): void {
  const last = runs[runs.length - 1];
  if (last && sameRun(last, run)) {
    last.text += run.text;
    return;
  }
  const next: AnsiRun = { text: run.text };
  if (run.style) next.style = run.style;
  if (run.href) next.href = run.href;
  runs.push(next);
}

/** True when anything here would render as anything but the text itself. */
export function hasAnsi(text: string): boolean {
  return text.indexOf("\x1b") >= 0;
}

/**
 * True for pwsh's `$PSStyle.Error`: bold plus ANSI red. A `2>&1` redirect puts
 * it on every line a command wrote to stderr, so on its own it marks which
 * stream a line came from rather than a failure
 * (components/PowerShellOutput.tsx).
 */
export function isErrorStreamStyle(style: AnsiStyle | undefined): style is AnsiStyle {
  return style?.bold === true && style.color === ANSI_16[1];
}

/** Split terminal text into the runs a screen can draw, one per style or link. */
export function parseAnsiRuns(text: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  const state = newState();
  let href: string | undefined;
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) !== 0x1b) {
      const next = text.indexOf("\x1b", i);
      const end = next < 0 ? text.length : next;
      pushRun(runs, { text: text.slice(i, end), style: styleOf(state), href });
      i = end;
      continue;
    }
    const rest = text.slice(i);
    const link = OSC_LINK_RE.exec(rest);
    if (link) {
      const url = link[1];
      href = url && LINK_PROTOCOLS.some((p) => url.startsWith(p)) ? url : undefined;
      i += link[0].length;
      continue;
    }
    if (PARTIAL_RE.test(rest)) break;
    const sgr = SGR_RE.exec(rest);
    if (sgr) {
      applySgr(state, sgr[1]);
      i += sgr[0].length;
      continue;
    }
    const other = OSC_RE.exec(rest) ?? CSI_RE.exec(rest) ?? ESC_RE.exec(rest);
    i += other ? other[0].length : 1;
  }
  return runs;
}
