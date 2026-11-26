import assert from "node:assert/strict";
import test from "node:test";

import { collapseTerminalOverwrites } from "./ansi-overwrite.ts";

// The shape @clack/prompts writes: one row per frame, each frame preceded by a move back
// to column 1 and an erase, captured from `npx skills add <repo> --list`.
const clackFrames =
  "\x1b[?25l│\n" +
  "◒  Cloning repository…\x1b[1G\x1b[J" +
  "◐  Cloning repository…\x1b[1G\x1b[J" +
  "◓  Cloning repository…\x1b[1G\x1b[J" +
  "◇  Repository cloned\x1b[?25h\n";

test("an animated spinner leaves its last frame", () => {
  assert.equal(collapseTerminalOverwrites(clackFrames), "│\n◇  Repository cloned\n");
});

test("a bar redrawn in place leaves the row it ended on", () => {
  const npm = "\x1b[2K\x1b[1G[##        ] 25%\x1b[2K\x1b[1G[##########] 100%\n";
  assert.equal(collapseTerminalOverwrites(npm), "[##########] 100%\n");
});

test("a redraw of a whole block drops the rows it erased", () => {
  const block = "\x1b[2K\x1b[1Gstep one\nstep two\x1b[1G\x1b[Jrunning again\n";
  assert.equal(collapseTerminalOverwrites(block), "step one\nrunning again\n");
});

test("a carriage return alone overwrites and keeps what the longer frame wrote", () => {
  // This is what a terminal shows: `\r` moves the cursor, it erases nothing.
  assert.equal(collapseTerminalOverwrites("Progress: 100%\rdone"), "doneress: 100%");
  assert.equal(collapseTerminalOverwrites("Progress: 100%\r\x1b[Kdone"), "done");
});

test("text with no moves is returned byte for byte, colours included", () => {
  const colored = "\x1b[31m1 fail\x1b[0m\n\x1b[32m3 pass\x1b[0m\n";
  assert.equal(collapseTerminalOverwrites(colored), colored);
  assert.equal(collapseTerminalOverwrites("plain output\nsecond line\n"), "plain output\nsecond line\n");
});

test("a colour is printed where its character survives, and not where it does not", () => {
  assert.equal(collapseTerminalOverwrites("\x1b[32m◐ building\x1b[1G\x1b[J\x1b[31m✗ failed\x1b[0m"), "\x1b[31m✗ failed\x1b[0m");
});

test("terminal state a card cannot draw is dropped, not printed as its parameters", () => {
  const raw = "\x1b]0;window title\x07\x1b[?25l◐ working\x1b[1G\x1b[J◇ done\x1b[?25h";
  assert.equal(collapseTerminalOverwrites(raw), "◇ done");
});

test("a cursor move places what is written next", () => {
  assert.equal(collapseTerminalOverwrites("\x1b[2;3Hhi\n"), "\n  hi\n");
  assert.equal(collapseTerminalOverwrites("abcdef\x1b[4DXY"), "abXYef");
  assert.equal(collapseTerminalOverwrites("abcdef\x1b[3G\x1b[2P"), "abef");
  assert.equal(collapseTerminalOverwrites("abcdef\x1b[3G\x1b[2X"), "ab  ef");
});

test("backspace retypes over the last character", () => {
  assert.equal(collapseTerminalOverwrites("hello\bx"), "hellx");
  assert.equal(collapseTerminalOverwrites("hello\x1b[Dx"), "hellx");
});

test("a jump past a screen of rows keeps the text as it came", () => {
  const crafted = "\x1b[999999;1Hhello\n";
  assert.equal(collapseTerminalOverwrites(crafted), crafted);
  const wide = "\x1b[1;999999Hhello\n";
  assert.equal(collapseTerminalOverwrites(wide), wide);
});

test("blank cells at the end of a row are not printed", () => {
  assert.equal(collapseTerminalOverwrites("aaaaaaaaaa\x1b[6D\x1b[K\n"), "aaaa\n");
});
