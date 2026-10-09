/**
 * A node-pty-compatible terminal backend for Bun, built on Bun's native PTY
 * support (the `terminal` option of `Bun.spawn`, see
 * https://bun.com/docs/runtime/child-process#terminal-pty-support).
 *
 * Why this exists: node-pty's native addon cannot keep the pty master fd alive
 * under Bun — the fd is closed right after `spawn()`, so the child reads EOF on
 * stdin and an interactive shell exits before it can print a prompt
 * (agegr/pi-web#745, cf. oven-sh/bun#7362). Bun's own terminal support owns the
 * master fd for the process's lifetime, so write, resize and exit all behave
 * the way node-pty's do, with no polling reader.
 *
 * Only the surface `lib/terminal-manager.ts` drives is implemented — spawn,
 * `onData`, `onExit`, `write`, `resize`, `kill` and `pid` — so the manager is
 * unchanged apart from which backend loads. Node.js and Windows keep using
 * node-pty. Zero extra dependencies.
 */

/** What a backend's `spawn` receives from the terminal manager. */
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** The subset of node-pty's `IPty` the terminal manager uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

// The types below mirror the Spawn reference in
// https://bun.com/docs/runtime/child-process, trimmed to what this backend
// uses. The repo has no `@types/bun` dependency; only the terminal backend
// touches these globals.
interface BunTerminalOptions {
  cols?: number;
  rows?: number;
  /** Terminal type for PTY configuration; `TERM` itself travels in `env`. */
  name?: string;
  data?: (terminal: BunTerminal, data: Uint8Array<ArrayBuffer>) => void;
}

interface BunTerminal {
  readonly closed: boolean;
  write(data: string | BufferSource): number;
  resize(cols: number, rows: number): void;
  setRawMode(enabled: boolean): void;
  /** Keep the event loop alive while the terminal is open. */
  ref(): void;
  unref(): void;
  close(): void;
}

interface BunSubprocess {
  readonly terminal: BunTerminal | undefined;
  readonly pid: number;
  /** Resolves with the process's exit code, including 128+signal conventions. */
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | number | null;
  readonly killed: boolean;
  kill(exitCode?: number | NodeJS.Signals): void;
  ref(): void;
  unref(): void;
}

interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  terminal?: BunTerminalOptions;
}

interface BunGlobal {
  spawn(command: string[], options?: BunSpawnOptions): BunSubprocess;
  spawn(options: { cmd: string[] } & BunSpawnOptions): BunSubprocess;
}

declare global {
  var Bun: BunGlobal | undefined;
}

export function spawnBunPty(file: string, args: string[], options: PtySpawnOptions): PtyProcess {
  if (typeof Bun === "undefined") {
    throw new Error("The Bun terminal backend requires the Bun runtime");
  }
  // Streaming decode, so a multi-byte character split across two reads still
  // arrives as one character — the same guarantee node-pty gets from its
  // `setEncoding("utf8")` socket.
  const decoder = new TextDecoder();
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  let exitEvent: { exitCode: number } | null = null;

  const subprocess = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    // Replaces the parent environment, exactly like node-pty's env option.
    env: options.env,
    terminal: {
      name: options.name,
      cols: options.cols,
      rows: options.rows,
      data: (_terminal, output) => {
        const text = decoder.decode(output, { stream: true });
        if (!text) return;
        for (const listener of [...dataListeners]) listener(text);
      },
    },
  });

  const terminal = subprocess.terminal;
  if (!terminal) {
    throw new Error(`Bun could not allocate a terminal for ${file}`);
  }
  // node-pty's read stream holds its fd the same way for the shell's lifetime.
  terminal.ref();

  const emitExit = (exitCode: number): void => {
    if (exitEvent) return;
    exitEvent = { exitCode };
    for (const listener of [...exitListeners]) listener(exitEvent);
  };
  subprocess.exited
    .then((exitCode) => emitExit(exitCode))
    .catch(() => emitExit(subprocess.exitCode ?? 0));

  return {
    pid: subprocess.pid,
    onData(listener) {
      dataListeners.add(listener);
    },
    onExit(listener) {
      // The exit promise settles as a microtask, but replaying a settled exit
      // also covers a shell that died while spawn() was still running.
      if (exitEvent) listener(exitEvent);
      else exitListeners.add(listener);
    },
    write(data) {
      terminal.write(data);
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    kill(signal) {
      // node-pty's default signal is SIGHUP; the manager escalates to SIGKILL.
      // node-pty types signals as plain strings, Bun as NodeJS.Signals; the
      // manager only ever passes "SIGKILL" or nothing.
      subprocess.kill((signal ?? "SIGHUP") as NodeJS.Signals);
    },
  };
}
