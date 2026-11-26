/**
 * What a terminal would have left on screen: an animated CLI redraws its spinner or
 * progress bar by moving the cursor back and erasing, never by writing new lines, so a
 * card that prints those bytes as text shows every frame it ever drew.
 *
 * SGR colours are left exactly as they came: this answers where the text ends up, not
 * what it looks like.
 */

const CSI_RE = /^\x1b\[([0-?]*)([@-~])/;
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const ESC_RE = /^\x1b[@-Z\\\-_]/;
// The moves and erases an animated command writes. `\x1b[?25l` (cursor visibility) and
// SGR (`m`) are not in this set: the first is dropped, the second passes through.
const TRIGGER_RE = /[\r\x08]|\x1b\[[0-?]*[@ABCDEFGHJKPXf]/;

const MAX_INPUT = 400_000;
const MAX_CELLS = 200_000;
const MAX_COLUMN = 10_000;
const MAX_ROW = 20_000;
const MAX_REPEAT = 1_000;

interface Cell {
  ch: string;
  /** Escape text that belongs in front of this character, kept as it came. */
  pre: string;
}

function count(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw === "" ? fallback : parseInt(raw.replace(/^[?>!]/, ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_REPEAT) : n === 0 ? 0 : fallback;
}

/** A cursor position (`G`, `H`) is an address, not a distance: only the screen bounds it. */
function position(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? 1 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
}

const blank = (): Cell => ({ ch: " ", pre: "" });

class Screen {
  rows: Cell[][] = [[]];
  row = 0;
  column = 0;
  /** Escape text not yet attached to a character: a colour, a reset at the stream's end. */
  pending = "";
  cells = 0;
  bail = false;

  ensureRow(row: number): void {
    // A jump past a screen's worth of rows is a crafted stream or a full-screen program:
    // the caller keeps the text as it came rather than drawing an empty screen for it.
    if (row > MAX_ROW) this.bail = true;
    const r = Math.max(0, Math.min(row, MAX_ROW));
    while (this.rows.length <= r) this.rows.push([]);
    this.row = r;
  }

  /** A row the stream jumped past stays empty, so the rows below keep their place. */
  current(): Cell[] {
    this.ensureRow(this.row);
    return this.rows[this.row];
  }

  addCells(n: number): void {
    this.cells += n;
    if (this.cells > MAX_CELLS) this.bail = true;
  }

  write(ch: string): void {
    const line = this.current();
    const col = Math.min(this.column, MAX_COLUMN);
    const pre = this.pending;
    this.pending = "";
    if (col < line.length) {
      line[col].ch = ch;
      line[col].pre = pre;
    } else {
      const grown = col - line.length;
      for (let i = 0; i < grown; i++) line.push(blank());
      line.push({ ch, pre });
      this.addCells(grown + 1);
    }
    this.column = col + 1;
  }

  /** Blank the cells from `from` to `to` (exclusive); past the line's end is already blank. */
  erase(from: number, to: number): void {
    const line = this.current();
    for (let i = Math.max(0, from); i < Math.min(to, line.length); i++) line[i] = blank();
  }

  eraseRows(from: number, to: number): void {
    for (let r = Math.max(0, from); r < Math.min(to, this.rows.length); r++) this.rows[r] = [];
  }

  flushPending(): void {
    if (!this.pending) return;
    // Trailing blanks are invisible on a terminal, so a reset that follows them belongs
    // after what the row kept rather than after the blanks.
    const line = this.current();
    while (line.length && line[line.length - 1].ch === " " && line[line.length - 1].pre === "") line.pop();
    line.push({ ch: "", pre: this.pending });
    this.pending = "";
  }
}

function applyCsi(s: Screen, params: string, final: string): boolean {
  const n = () => count(params, 1);
  switch (final) {
    case "A":
      s.ensureRow(s.row - n());
      return true;
    case "B":
      s.ensureRow(s.row + n());
      return true;
    case "C":
      s.column = Math.min(s.column + n(), MAX_COLUMN);
      return true;
    case "D":
      s.column = Math.max(0, s.column - n());
      return true;
    case "E":
      s.ensureRow(s.row + n());
      s.column = 0;
      return true;
    case "F":
      s.ensureRow(s.row - n());
      s.column = 0;
      return true;
    case "G": {
      const col = position(params) - 1;
      if (col > MAX_COLUMN) s.bail = true;
      s.column = col;
      return true;
    }
    case "H":
    case "f": {
      const [row, col] = params.split(/[;:]/);
      const target = position(col) - 1;
      if (target > MAX_COLUMN) s.bail = true;
      s.ensureRow(position(row) - 1);
      s.column = target;
      return true;
    }
    case "J": {
      const mode = count(params, 0);
      if (mode === 0) {
        s.erase(s.column, MAX_COLUMN);
        s.eraseRows(s.row + 1, s.rows.length);
      } else if (mode === 1) {
        s.erase(0, s.column);
        s.eraseRows(0, s.row);
      } else if (mode === 2) {
        s.eraseRows(0, s.rows.length);
      }
      return true;
    }
    case "K": {
      const mode = count(params, 0);
      if (mode === 0) s.erase(s.column, MAX_COLUMN);
      else if (mode === 1) s.erase(0, s.column);
      else if (mode === 2) s.erase(0, MAX_COLUMN);
      return true;
    }
    case "P": {
      const line = s.current();
      const cut = Math.min(line.length, s.column + n());
      line.splice(s.column, cut - s.column);
      return true;
    }
    case "X": {
      const line = s.current();
      s.erase(s.column, Math.min(line.length, s.column + n()));
      return true;
    }
    case "@": {
      const line = s.current();
      const blanks: Cell[] = [];
      for (let i = 0; i < n(); i++) blanks.push(blank());
      line.splice(s.column, 0, ...blanks);
      s.addCells(blanks.length);
      return true;
    }
    default:
      return false;
  }
}

export function collapseTerminalOverwrites(text: string): string {
  if (text.length > MAX_INPUT) return text;
  if (!TRIGGER_RE.test(text)) return text;

  const s = new Screen();
  for (let i = 0; i < text.length; i++) {
    if (s.bail) return text;
    const ch = text[i];

    if (ch === "\x1b") {
      const rest = text.slice(i);
      const csi = CSI_RE.exec(rest);
      if (csi) {
        const [, params, final] = csi;
        if (params.startsWith("?")) {
          // DEC private modes (cursor visibility, alternate screen, line wrapping): a card
          // has no such state, and printing their parameters is what leaves `[?25l` visible.
        } else if (final === "m") {
          s.pending += csi[0];
        } else if (!applyCsi(s, params, final)) {
          s.pending += csi[0];
        }
        i += csi[0].length - 1;
        continue;
      }
      const osc = OSC_RE.exec(rest);
      if (osc) {
        i += osc[0].length - 1;
        continue;
      }
      const esc = ESC_RE.exec(rest);
      if (esc) {
        i += esc[0].length - 1;
        continue;
      }
      s.pending += ch;
      continue;
    }

    if (ch === "\n") {
      s.flushPending();
      s.ensureRow(s.row + 1);
      s.column = 0;
      continue;
    }
    if (ch === "\r") {
      s.column = 0;
      continue;
    }
    if (ch === "\b") {
      s.column = Math.max(0, s.column - 1);
      continue;
    }
    if (ch < " ") {
      if (ch === "\t") s.write("\t");
      continue;
    }
    s.write(ch);
  }

  if (s.bail) return text;
  s.flushPending();
  const lines: string[] = [];
  for (const row of s.rows) {
    let line = "";
    for (const cell of row) line += cell.pre + cell.ch;
    lines.push(line.replace(/[ \t]+$/, ""));
  }
  return lines.join("\n");
}
