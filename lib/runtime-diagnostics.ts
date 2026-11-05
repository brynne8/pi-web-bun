import fs from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { freemem, totalmem, constants, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

const SINGLETON = Symbol.for("pi-web.runtimeDiagnostics");
const RUN = /^run-(\d+)-(\d+)-([a-f0-9-]{36})\.run\.json$/;
const MAX_BYTES = 1024 * 1024;
const HISTORY = 16;

/** Resolve the startup journal before the SDK can load or fail. */
export function runtimeDiagnosticsDirectory(configured = process.env.PI_CODING_AGENT_DIR, home = homedir()): string {
  let directory = configured || join(home, ".pi", "agent");
  if (directory === "~") directory = home;
  else if (directory.startsWith("~/") || directory.startsWith("~\\")) directory = join(home, directory.slice(2));
  else if (directory.startsWith("file://")) directory = fileURLToPath(directory);
  return join(directory, "pi-web", "diagnostics");
}

export interface RuntimeCounts {
  rpcSessions: number;
  startLocks: number;
  sseStreams: number;
  running: number;
  closing: number;
  compacting: number;
  subagents: number;
  sseQueuedBytes: number;
  sseDroppedEvents: number;
}

export interface RuntimeDiagnosticDetails {
  "session-start": { subagent?: boolean };
  "session-closed": { subagent?: boolean };
  backpressure: { queuedBytes: number; droppedEvents: number; action: "drop" | "close" };
  shutdown: { signal: "SIGINT" | "SIGTERM"; phase?: "started" | "completed" | "deadline"; graceful?: boolean; rejectedCleanups?: number };
}

type RuntimeDiagnosticEvent = {
  [K in keyof RuntimeDiagnosticDetails]: { event: K } & RuntimeDiagnosticDetails[K]
}[keyof RuntimeDiagnosticDetails];

export interface RuntimeDiagnosticsOptions {
  directory: string;
  collect?: () => Partial<RuntimeCounts>;
  maxBytes?: number;
  archives?: number;
  retainedRuns?: number;
}

export interface RuntimeDiagnostics {
  sample(): void;
  stop(): void;
  dispose(): void;
  record(event: RuntimeDiagnosticEvent): void;
}

function readSafely<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Reads app-owned debug getters only; never calls extension liveness providers. */
export function collectRuntimeCounts(): RuntimeCounts {
  const globals = globalThis as Record<PropertyKey, unknown>;
  const size = (value: unknown) => value instanceof Map || value instanceof Set ? value.size : 0;
  const counts = {
    rpcSessions: size(globals.__piSessions),
    startLocks: size(globals.__piStartLocks),
    sseStreams: size(globals[Symbol.for("pi-web.agentEventStreamClosers")]),
    running: 0, closing: 0, compacting: 0, subagents: 0, sseQueuedBytes: 0, sseDroppedEvents: 0,
  };
  if (globals.__piSessions instanceof Map) {
    for (const wrapper of globals.__piSessions.values()) {
      const snapshot = readSafely(() => wrapper.getDebugSnapshot(), null);
      if (!snapshot) continue;
      if (readSafely(() => snapshot.run.running === true, false)) counts.running++;
      if (readSafely(() => snapshot.state === "closing", false)) counts.closing++;
      if (readSafely(() => snapshot.run.compacting === true, false)) counts.compacting++;
      if (readSafely(() => snapshot.subagent === true, false)) counts.subagents++;
    }
  }
  const infos = globals[Symbol.for("pi-web.agentEventStreamInfos")];
  if (infos instanceof Map) {
    for (const info of infos.values()) {
      counts.sseQueuedBytes = Math.min(Number.MAX_SAFE_INTEGER, counts.sseQueuedBytes + count(readSafely(() => info.queuedBytes(), 0)));
      counts.sseDroppedEvents = Math.min(Number.MAX_SAFE_INTEGER, counts.sseDroppedEvents + count(readSafely(() => info.droppedEvents(), 0)));
    }
  }
  return counts;
}

const SAFE_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "SystemError", "AbortError", "AssertionError", "Warning", "DeprecationWarning",
  "ExperimentalWarning", "MaxListenersExceededWarning", "TimeoutOverflowWarning", "TimeoutNegativeWarning",
]);
const STORAGE_ERRNOS = new Set(Object.keys(constants.errno));
const SAFE_CODES = new Set([
  ...STORAGE_ERRNOS, "ERR_OUT_OF_MEMORY", "ERR_WORKER_OUT_OF_MEMORY", "ERR_UNHANDLED_REJECTION",
  "ERR_STREAM_DESTROYED", "ERR_STREAM_PREMATURE_CLOSE", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_INVALID_SESSION",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_ASSERTION", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND",
]);

function safeCode(value: unknown): string | null {
  return typeof value === "string" && (SAFE_CODES.has(value) || /^DEP\d{4}$/.test(value)) ? value : null;
}

/** Omits messages, function names and directories; caps stack work and output. */
export function sanitizeRuntimeError(error: unknown) {
  const object = error as { name?: unknown; code?: unknown; stack?: unknown } | null;
  const name = readSafely(() => object?.name, undefined);
  const code = safeCode(readSafely(() => object?.code, undefined));
  const stack = readSafely(() => object?.stack, undefined);
  const frames: { file: string; line: number; column: number }[] = [];
  if (typeof stack === "string") {
    for (const frame of stack.slice(0, 16_384).split("\n").slice(1, 65)) {
      // Match runtime frame lines, never the error's first line or arbitrary message text.
      if (!/^\s*at\s/.test(frame)) continue;
      const location = /(?:^|[\s(/\\])([A-Za-z0-9_.-]{1,80}\.(?:[cm]?js|tsx?|jsx)):(\d{1,9}):(\d{1,9})\)?\s*$/.exec(frame);
      if (!location) continue;
      frames.push({ file: location[1], line: Number(location[2]), column: Number(location[3]) });
      if (frames.length === 8) break;
    }
  }
  return { name: typeof name === "string" && SAFE_NAMES.has(name) ? name : "OtherError", code, frames };
}

/** Closed schema for aggregate lifecycle points; ignores unknown events and extra fields. */
export function recordRuntimeDiagnostic(...[event, details]: {
  [K in keyof RuntimeDiagnosticDetails]: [K, RuntimeDiagnosticDetails[K]]
}[keyof RuntimeDiagnosticDetails]): void {
  readSafely(() => {
    const instance = (globalThis as Record<PropertyKey, unknown>)[SINGLETON] as RuntimeDiagnostics | undefined;
    instance?.record({ ...details, event } as RuntimeDiagnosticEvent);
  }, undefined);
}

function pidState(pid: number): "active" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return "active"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

function limit(value: number | undefined, fallback: number, maximum: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;
}

/** One journal per process, shared across instrumentation bundles and hot reloads. */
export function installRuntimeDiagnostics(options: RuntimeDiagnosticsOptions): RuntimeDiagnostics {
  const globals = globalThis as Record<PropertyKey, unknown>;
  if (globals[SINGLETON]) return globals[SINGLETON] as RuntimeDiagnostics;
  const maxBytes = limit(options.maxBytes, MAX_BYTES, MAX_BYTES);
  const archives = limit(options.archives, 3, 3);
  const retainedRuns = limit(options.retainedRuns, HISTORY, HISTORY);
  const stem = `run-${process.pid}-${Date.now()}-${randomUUID()}`;
  const journal = join(options.directory, `${stem}.jsonl`);
  const marker = join(options.directory, `${stem}.run.json`);
  let stopped = false;
  let fatal = false;
  let incompleteShutdown = false;
  let bytes = 0;
  let delay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let storageWarned = false;
  const safe = (action: () => void) => { try { action(); } catch { /* Diagnostics must never terminate the server. */ } };
  const storage = (action: () => void) => {
    try { action(); } catch (error) {
      if (storageWarned) return;
      storageWarned = true;
      const code = readSafely(() => (error as NodeJS.ErrnoException)?.code, undefined);
      safe(() => console.warn(`[pi-web] runtime diagnostics storage unavailable (${typeof code === "string" && STORAGE_ERRNOS.has(code) ? code : "UNKNOWN"})`));
    }
  };
  const writeMarker = (state: string) => storage(() => {
    fs.writeFileSync(marker, JSON.stringify({ state }), { mode: 0o600 });
  });
  const append = (event: string, data: object = {}) => storage(() => {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n";
    const length = Buffer.byteLength(line);
    if (length > maxBytes) return;
    if (bytes + length > maxBytes) {
      for (let index = archives; index >= 1; index--) {
        const target = `${journal}.${index}`;
        try { fs.unlinkSync(target); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const source = index === 1 ? journal : `${journal}.${index - 1}`;
        try { fs.renameSync(source, target); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      bytes = 0;
    }
    fs.appendFileSync(journal, line, { mode: 0o600 });
    bytes += length;
  });
  const previous = { unclean: 0, exited: 0, active: 0, unknown: 0 };
  storage(() => {
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const dead: { name: string; time: number }[] = [];
    for (const name of fs.readdirSync(options.directory)) {
      const match = RUN.exec(name);
      if (!match) continue;
      const state = pidState(Number(match[1]));
      if (state !== "dead") { previous[state]++; continue; }
      dead.push({ name, time: Number(match[2]) });
      try {
        const path = join(options.directory, name);
        if (fs.statSync(path).size > 2048) throw new Error();
        const saved = JSON.parse(fs.readFileSync(path, "utf8"));
        if (saved.state === "running" || saved.state === "fatal" || saved.state === "failed") previous.unclean++;
        else if (saved.state === "exited" || saved.state === "disposed") previous.exited++;
        else previous.unknown++;
      } catch { previous.unknown++; }
    }
    // Live or indeterminate PIDs are never pruned, including when a PID was reused.
    dead.sort((a, b) => b.time - a.time);
    for (const { name } of dead.slice(retainedRuns - 1)) {
      const base = join(options.directory, name.replace(/\.run\.json$/, ""));
      for (const suffix of [".run.json", ".jsonl", ".jsonl.1", ".jsonl.2", ".jsonl.3"]) {
        safe(() => fs.unlinkSync(base + suffix));
      }
    }
  });
  writeMarker("running");
  safe(() => { delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable(); });

  const sampleData = () => {
    const memory = process.memoryUsage();
    const resource = process.resourceUsage();
    const rawCounts = readSafely(() => (options.collect ?? collectRuntimeCounts)(), null);
    const counts: Partial<RuntimeCounts> = {};
    for (const key of ["rpcSessions", "startLocks", "sseStreams", "running", "closing", "compacting", "subagents", "sseQueuedBytes", "sseDroppedEvents"] as const) {
      counts[key] = count(readSafely(() => rawCounts?.[key], undefined));
    }
    return {
      uptimeSeconds: process.uptime(),
      memory: { ...memory, maxRssBytes: resource.maxRSS * 1024, systemFreeBytes: freemem(), systemTotalBytes: totalmem() },
      cpuTimeMicros: { user: resource.userCPUTime, system: resource.systemCPUTime },
      eventLoopDelayMs: delay && delay.count > 0
        ? { mean: delay.mean / 1e6, max: delay.max / 1e6, p99: delay.percentile(99) / 1e6 } : null,
      counts,
      collectorFailed: rawCounts === null,
    };
  };
  const sample = () => {
    if (stopped) return;
    safe(() => append("sample", sampleData()));
    safe(() => delay?.reset());
  };
  const onFatal = (error: Error, origin: string) => {
    fatal = true;
    safe(() => append("fatal", { origin: origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", exception: sanitizeRuntimeError(error) }));
    writeMarker("fatal");
  };
  const onWarning = (warning: Error) => safe(() => {
    const { name, code } = sanitizeRuntimeError(warning);
    append("warning", { name, code });
  });
  const onExit = (code: number) => {
    append("exit", { code, fatalObserved: fatal });
    writeMarker(fatal ? "fatal" : incompleteShutdown || code !== 0 ? "failed" : "exited");
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    safe(() => delay?.disable());
    process.off("uncaughtExceptionMonitor", onFatal);
    process.off("warning", onWarning);
    process.off("exit", onExit);
    append("disposed");
    writeMarker(fatal ? "fatal" : "disposed");
    if (globals[SINGLETON] === instance) delete globals[SINGLETON];
  };
  const record = (event: RuntimeDiagnosticEvent) => safe(() => {
    if (stopped || !event) return;
    let accepted = false;
    switch (event.event) {
      case "session-start":
      case "session-closed":
        append(event.event, { subagent: event.subagent === true });
        accepted = true;
        break;
      case "backpressure":
        if (event.action === "drop" || event.action === "close") {
          append(event.event, { action: event.action, queuedBytes: count(event.queuedBytes), droppedEvents: count(event.droppedEvents) });
          accepted = true;
        }
        break;
      case "shutdown":
        if (["started", "completed", "deadline"].includes(event.phase ?? "started") && ["SIGINT", "SIGTERM"].includes(event.signal)) {
          if (event.phase === "deadline" || (event.phase === "completed" && event.graceful === false)) {
            incompleteShutdown = true;
            writeMarker("failed");
          }
          append(event.event, {
            phase: event.phase ?? "started", signal: event.signal,
            ...(typeof event.graceful === "boolean" ? { graceful: event.graceful } : {}),
            ...(event.rejectedCleanups !== undefined ? { rejectedCleanups: count(event.rejectedCleanups) } : {}),
          });
          accepted = true;
        }
        break;
    }
    if (accepted) sample();
  });
  const instance = { sample, stop, dispose: stop, record };
  globals[SINGLETON] = instance;
  process.on("uncaughtExceptionMonitor", onFatal);
  process.on("warning", onWarning);
  process.on("exit", onExit);
  const executable = basename(process.execPath);
  append("startup", { runtime: { node: process.versions.node, bun: process.versions.bun ?? null }, executableBasename: /^[A-Za-z0-9_.-]{1,80}$/.test(executable) ? executable : "unknown", platform: process.platform, arch: process.arch, ppid: process.ppid, previous });
  sample();
  const timer = setInterval(sample, 30_000);
  timer.unref?.();
  return instance;
}
