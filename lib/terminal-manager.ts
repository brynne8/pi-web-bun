import { randomUUID } from "crypto";
import { homeDir } from "./home-dir";
import type { PtyProcess, PtySpawn } from "./terminal-bun-pty";
import { samePath } from "./paths";

export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

type TerminalListener = (event: TerminalEvent) => void;

interface TerminalRecord {
  pty: PtyProcess;
  cwd: string;
  listeners: Set<TerminalListener>;
  backlog: string;
  offset: number;
  exited: boolean;
  exitCode: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

declare global {
  var __piWebTerminals: Map<string, TerminalRecord> | undefined;
}

// ponytail: bounded replay; use terminal serialization if full-screen snapshots become necessary.
const MAX_BACKLOG = 128 * 1024;
export const TERMINAL_RECONNECT_MS = 120_000;

// A burst such as `yes` hands the terminal tens of thousands of small chunks a
// second, and each one used to reach the SSE stream as its own frame. Output is
// merged and released once it reaches MAX_OUTPUT_FRAME, or at the next idle gap.
const MAX_OUTPUT_FRAME = 64 * 1024;
const OUTPUT_FLUSH_MS = 16;

/**
 * Merges PTY output so a firehose cannot grow memory with output a consumer
 * still has to drain: a frame is released once the buffer reaches `maxBytes`,
 * and the buffer never holds more than one read past it.
 */
export class TerminalOutputQueue {
  private pending = "";

  constructor(private readonly maxBytes: number) {}

  /** Merges `chunk`, returning the frame to forward now, or "" while it waits. */
  push(chunk: string): string {
    if (this.pending.length + chunk.length < this.maxBytes) {
      this.pending += chunk;
      return "";
    }
    // The chunk would pass the cap, so the buffered frame goes now and the
    // chunk starts the next one; no byte is dropped to hold the bound.
    const frame = this.pending;
    this.pending = chunk;
    return frame;
  }

  /** The buffered frame, removed. */
  flush(): string {
    const data = this.pending;
    this.pending = "";
    return data;
  }
}

function registry(): Map<string, TerminalRecord> {
  if (!globalThis.__piWebTerminals) {
    globalThis.__piWebTerminals = new Map();
    const shutdown = () => {
      for (const id of globalThis.__piWebTerminals!.keys()) killTerminal(id, true);
    };
    process.once("exit", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piWebTerminals;
}

function shellEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The browser login password guards this server, not the shells it starts.
    const comparableKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (value !== undefined && comparableKey !== "PI_WEB_PASSWORD") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  // Windows shells (Git Bash / MSYS2, cmd, PowerShell) otherwise inherit the
  // system ANSI codepage (e.g. GBK on zh-CN) and mangle non-ASCII filenames.
  if (!process.env.LANG && !process.env.LC_ALL && !process.env.LC_CTYPE) env.LANG = "C.UTF-8";
  return env;
}

function emit(record: TerminalRecord, event: TerminalEvent): void {
  for (const listener of record.listeners) listener(event);
}

function scheduleCleanup(id: string, record: TerminalRecord): void {
  if (record.cleanupTimer || record.listeners.size || registry().get(id) !== record) return;
  record.cleanupTimer = setTimeout(() => killTerminal(id), TERMINAL_RECONNECT_MS);
  record.cleanupTimer.unref?.();
}

function dimension(value: number, fallback: number): number {
  return Math.min(1000, Math.max(2, Number.isFinite(value) ? Math.floor(value) : fallback));
}

/**
 * Picks the pty backend at creation time: `spawnBunPty` under Bun, node-pty
 * elsewhere, Windows included. node-pty's native addon cannot keep the pty
 * master fd alive under Bun, where Bun's own PTY holds it for the process's
 * lifetime (agegr/pi-web#745, cf. oven-sh/bun#7362); Windows keeps node-pty
 * for its pipe-based ConPTY and untranslated `\r` (docs/terminal.md).
 */
function loadPtySpawn(): PtySpawn {
  if (typeof Bun !== "undefined" && process.platform !== "win32") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("./terminal-bun-pty") as typeof import("./terminal-bun-pty")).spawnBunPty;
  }
  try {
    // Load inside creation so native module failures reach the API's JSON error handler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node-pty") as typeof import("node-pty");
    return spawn as unknown as PtySpawn;
  } catch (error) {
    throw new Error(
      `Cannot load the node-pty native terminal module for ${process.platform}-${process.arch}. ` +
      "The binary may be missing or incompatible. In the pi-web installation directory " +
      "(the npx cache directory when using npx), run: npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts. " +
      "On Debian/Ubuntu, install build tools first: sudo apt-get install -y python3 build-essential. " +
      `Then restart pi-web. Original error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export function createTerminal(cwd: string, cols: number, rows: number, id: string = randomUUID()): string {
  const existing = registry().get(id);
  if (existing) {
    if (!samePath(existing.cwd, cwd)) throw new Error("Terminal belongs to a different workspace");
    return id;
  }
  const shell = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? [] : ["-l"];
  const pty = loadPtySpawn()(shell, args, {
    name: "xterm-256color",
    cols: dimension(cols, 80),
    rows: dimension(rows, 24),
    cwd: cwd || homeDir(),
    env: shellEnvironment(),
  });
  const record: TerminalRecord = {
    pty,
    cwd,
    listeners: new Set(),
    backlog: "",
    offset: 0,
    exited: false,
    exitCode: null,
    cleanupTimer: null,
  };
  registry().set(id, record);
  // Includes creations whose response or initial SSE connection never arrives.
  scheduleCleanup(id, record);

  const output = new TerminalOutputQueue(MAX_OUTPUT_FRAME);
  let outputTimer: ReturnType<typeof setTimeout> | null = null;
  const forwardOutput = (data: string): void => {
    record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
    record.offset += data.length;
    emit(record, { type: "output", data, offset: record.offset });
  };
  const flushOutput = (): void => {
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = null;
    const data = output.flush();
    if (data) forwardOutput(data);
  };

  pty.onData((data) => {
    const frame = output.push(data);
    if (frame) forwardOutput(frame);
    // A frame may leave the current chunk buffered, so the timer is scheduled
    // from the buffer's state, not from whether this read produced a frame.
    if (!outputTimer) {
      outputTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
      outputTimer.unref?.();
    }
  });
  pty.onExit(({ exitCode }) => {
    // What is still buffered is the shell's last output, and it has to precede
    // the exit event: that is what ends the stream.
    flushOutput();
    if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
    record.cleanupTimer = null;
    record.exited = true;
    record.exitCode = exitCode;
    emit(record, { type: "exit", exitCode });
    scheduleCleanup(id, record);
  });
  return id;
}

export function hasTerminal(id: string): boolean {
  return registry().has(id);
}

export function getTerminalCwd(id: string): string | undefined {
  return registry().get(id)?.cwd;
}

export function subscribeTerminal(
  id: string,
  listener: TerminalListener,
  after?: number,
): { output: Extract<TerminalEvent, { type: "output" }>; exited: boolean; exitCode: number | null; unsubscribe: () => void } | null {
  const record = registry().get(id);
  if (!record) return null;
  record.listeners.add(listener);
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  record.cleanupTimer = null;
  const start = record.offset - record.backlog.length;
  const reset = after === undefined || after < start || after > record.offset;
  return {
    output: {
      type: "output",
      data: reset ? record.backlog : record.backlog.slice(after - start),
      offset: record.offset,
      reset,
    },
    exited: record.exited,
    exitCode: record.exitCode,
    unsubscribe: () => {
      record.listeners.delete(listener);
      scheduleCleanup(id, record);
    },
  };
}

export function writeTerminal(id: string, data: string): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const record = registry().get(id);
  if (!record || record.exited) return false;
  record.pty.resize(dimension(cols, 80), dimension(rows, 24));
  return true;
}

// Closing a tab asks first and insists later: SIGTERM for the shell's jobs, the
// SIGHUP an interactive shell exits on, then SIGKILL for one that traps both.
const TERMINAL_HANGUP_MS = 200;
const TERMINAL_KILL_MS = 1800;

export function killTerminal(id: string, force = false): boolean {
  const record = registry().get(id);
  if (!record) return false;
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  registry().delete(id);
  if (!record.exited) {
    record.pty.kill(force ? "SIGKILL" : "SIGTERM");
    if (!force) {
      record.cleanupTimer = setTimeout(() => {
        if (record.exited) return;
        record.pty.kill("SIGHUP");
        // Explicit close and lease expiry must still finish.
        record.cleanupTimer = setTimeout(() => {
          if (!record.exited) record.pty.kill("SIGKILL");
        }, TERMINAL_KILL_MS);
        record.cleanupTimer.unref?.();
      }, TERMINAL_HANGUP_MS);
      record.cleanupTimer.unref?.();
    }
  }
  emit(record, { type: "closed" });
  record.listeners.clear();
  return true;
}
