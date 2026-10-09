import { randomUUID } from "crypto";
import { closeSync, read } from "fs";
import { homedir } from "os";
import type { IPty } from "node-pty";
import { samePath } from "./paths";

export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

type TerminalListener = (event: TerminalEvent) => void;

interface TerminalRecord {
  pty: IPty;
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

function spawnPty(
  spawn: typeof import("node-pty").spawn,
  ...args: Parameters<typeof import("node-pty").spawn>
): ReturnType<typeof import("node-pty").spawn> {
  if (!("bun" in process.versions)) return spawn(...args);

  // Bun's tty.ReadStream treats the first EAGAIN from node-pty's O_NONBLOCK pty
  // master fd as fatal: it destroys the stream and closes the fd, so the shell
  // is SIGHUPed before it writes a byte (oven-sh/bun#25822, unfixed through
  // Bun 1.4.2). node-pty only touches tty.ReadStream while building its read
  // stream, so swapping a polling reader in around spawn() is enough; its write,
  // resize and exit paths already work under Bun.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tty = require("node:tty") as typeof import("node:tty");
  const { Readable } = require("node:stream") as typeof import("node:stream");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const nativeReadStream = tty.ReadStream;

  class PollingReadStream extends Readable {
    private readonly buffer = Buffer.alloc(64 * 1024);
    private retryDelayMs = 1;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly fd: number) {
      super({ highWaterMark: 64 * 1024, autoDestroy: true });
      this.poll();
    }

    _read(): void {}

    private poll(): void {
      read(this.fd, this.buffer, 0, this.buffer.length, null, (error, bytesRead) => {
        if (this.destroyed) return;
        if (error) {
          // EAGAIN only means "nothing yet" on a non-blocking fd. The slave side
          // going away (EIO) or an already closed fd (EBADF) ends the stream.
          if (error.code === "EAGAIN") {
            this.retryTimer = setTimeout(() => this.poll(), this.retryDelayMs);
            this.retryDelayMs = Math.min(this.retryDelayMs * 2, 8);
            return;
          }
          if (error.code === "EIO" || error.code === "EBADF") {
            this.push(null);
            return;
          }
          this.destroy(error);
          return;
        }
        this.retryDelayMs = 1;
        if (bytesRead === 0) {
          this.push(null);
          return;
        }
        // Copy: the next read overwrites buffer while this slice is still queued.
        this.push(Buffer.from(this.buffer.subarray(0, bytesRead)));
        setImmediate(() => this.poll());
      });
    }

    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      try {
        closeSync(this.fd);
      } catch {
        // The fd is already gone.
      }
      callback(error);
    }
  }

  Object.defineProperty(tty, "ReadStream", { value: PollingReadStream, configurable: true, writable: true });
  try {
    return spawn(...args);
  } finally {
    Object.defineProperty(tty, "ReadStream", { value: nativeReadStream, configurable: true, writable: true });
  }
}

export function createTerminal(cwd: string, cols: number, rows: number, id: string = randomUUID()): string {
  const existing = registry().get(id);
  if (existing) {
    if (!samePath(existing.cwd, cwd)) throw new Error("Terminal belongs to a different workspace");
    return id;
  }
  let spawn: typeof import("node-pty").spawn;
  try {
    // Load inside creation so native module failures reach the API's JSON error handler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ spawn } = require("node-pty") as typeof import("node-pty"));
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
  const shell = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : process.env.SHELL || "/bin/sh";
  const args = process.platform === "win32" ? [] : ["-l"];
  const pty = spawnPty(spawn, shell, args, {
    name: "xterm-256color",
    cols: dimension(cols, 80),
    rows: dimension(rows, 24),
    cwd: cwd || homedir(),
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

  pty.onData((data) => {
    record.backlog = (record.backlog + data).slice(-MAX_BACKLOG);
    record.offset += data.length;
    emit(record, { type: "output", data, offset: record.offset });
  });
  pty.onExit(({ exitCode }) => {
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

export function killTerminal(id: string, force = false): boolean {
  const record = registry().get(id);
  if (!record) return false;
  if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
  registry().delete(id);
  if (!record.exited) {
    record.pty.kill(force ? "SIGKILL" : undefined);
    // A shell may trap SIGHUP; explicit close and lease expiry must still finish.
    if (!force) {
      record.cleanupTimer = setTimeout(() => {
        if (!record.exited) record.pty.kill("SIGKILL");
      }, 2000);
      record.cleanupTimer.unref?.();
    }
  }
  emit(record, { type: "closed" });
  record.listeners.clear();
  return true;
}
