"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getAgentDir } = require("./run-records.cjs");
const { wireChildProcessLifecycle } = require("./process-lifecycle.cjs");
const { findVinextCli } = require("./vinext-cli.cjs");

const MAX_BYTES = 64 * 1024;
const RETAINED_RUNS = 16;
const STDERR_DRAIN_TIMEOUT_MS = 1_000;
const JOURNAL_NAME = /^supervisor-(\d+)-\d+-([a-f0-9-]{36})\.jsonl$/;
const FATAL_MARKERS = [
  [/FATAL ERROR[\s\S]{0,160}heap out of memory/i, "heap-out-of-memory"],
  [/(?:bun\s+panic|panic:|segmentation fault|segfault|assertion failed|fatal assertion)/i, "native-fatal"],
];
const STDERR_MARKERS = [[/out of memory/i, "out-of-memory"]];

function diagnosticsDirectory(env = process.env, home = os.homedir()) {
  return path.join(getAgentDir(env, home), "pi-web", "diagnostics");
}
function commandName(command) { return path.basename(command).replace(/\.(?:cmd|bat|exe)$/i, ""); }
function resolveVinextCommand(pkgDir, platform = process.platform, fallbackRuntime = "node") {
  const binDir = path.join(pkgDir, "node_modules", ".bin");
  const candidates = platform === "win32" ? [path.join(binDir, "vinext.exe")] : [path.join(binDir, "vinext")];
  for (const command of candidates) {
    try { if (fs.statSync(command).isFile()) return { command, argsPrefix: [], fallback: false }; } catch { /* fallback */ }
  }
  const cli = findVinextCli(pkgDir);
  if (cli) return { command: fallbackRuntime, argsPrefix: [cli], fallback: true };
  throw new Error("Could not find the vinext executable or CLI");
}
function pidState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try { process.kill(pid, 0); return "live"; } catch (error) { return error && error.code === "ESRCH" ? "dead" : "unknown"; }
}
function pruneJournals(directory, keepDead = RETAINED_RUNS - 1) {
  let entries;
  try { entries = fs.readdirSync(directory); } catch { return; }
  const journals = [];
  for (const name of entries) {
    const match = JOURNAL_NAME.exec(name);
    if (!match || pidState(Number(match[1])) !== "dead") continue;
    try { journals.push({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }); } catch { /* retain */ }
  }
  journals.sort((a, b) => b.mtime - a.mtime);
  for (const { name } of journals.slice(Math.max(0, keepDead))) {
    try { fs.unlinkSync(path.join(directory, name)); } catch { /* best effort */ }
  }
}
function safeError(error) {
  const name = error && error.name;
  const code = error && error.code;
  return {
    name: ["Error", "TypeError", "RangeError", "SystemError"].includes(name) ? name : "Error",
    code: typeof code === "string" && Object.hasOwn(os.constants.errno, code) ? code : undefined,
  };
}
function createJournal(directory, { pid = process.pid, now = Date.now(), id = crypto.randomUUID(), warn = console.warn } = {}) {
  let file;
  let bytes = 0;
  let warned = false;
  const warnOnce = (error) => {
    if (warned) return;
    warned = true;
    try { warn(`[pi-web] supervisor diagnostics unavailable (${safeError(error).code ?? "UNKNOWN"})`); } catch { /* optional */ }
  };
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    pruneJournals(directory);
    file = path.join(directory, `supervisor-${pid}-${now}-${id}.jsonl`);
  } catch (error) { warnOnce(error); }
  const append = (event, data = {}) => {
    if (!file) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid, event, ...data }) + "\n";
    const budget = ["exit", "close", "spawn-error", "fatal-stderr", "stderr-marker"].includes(event) ? MAX_BYTES : MAX_BYTES - 4096;
    if (bytes + Buffer.byteLength(line) > budget) return;
    try { fs.appendFileSync(file, line, { mode: 0o600 }); bytes += Buffer.byteLength(line); }
    catch (error) { warnOnce(error); file = undefined; }
  };
  return { file, append };
}
function classifyStderr(text) {
  for (const [pattern, category] of FATAL_MARKERS) if (pattern.test(text)) return ["fatal-stderr", category];
  for (const [pattern, category] of STDERR_MARKERS) if (pattern.test(text)) return ["stderr-marker", category];
  return undefined;
}
function forwardStderr(child, output, onMarker) {
  if (!child.stderr) return { close: (done) => done(false) };
  let tail = "";
  let waiting = false;
  let pendingWrites = 0;
  let finishDrain;
  let closed = false;
  let timer;
  const onDrain = () => { waiting = false; child.stderr.resume(); };
  const onData = (chunk) => {
    const text = chunk.toString();
    const marker = classifyStderr(tail + text);
    if (marker) onMarker(...marker);
    tail = (tail + text).slice(-512);
    pendingWrites++;
    const writable = output.write(chunk, () => {
      pendingWrites--;
      if (pendingWrites === 0 && finishDrain) finishDrain(false);
    });
    if (!writable && !waiting) {
      waiting = true;
      child.stderr.pause();
      output.once("drain", onDrain);
    }
  };
  child.stderr.on("data", onData);
  return { close(done) {
    if (closed) return;
    closed = true;
    // Only the already buffered bytes are consumed if a descendant holds the
    // pipe open. No stderr content is ever written to the diagnostics journal.
    child.stderr.removeListener("data", onData);
    const buffered = child.stderr.read(child.stderr.readableLength);
    if (buffered !== null) onData(buffered);
    let called = false;
    finishDrain = (timedOut) => {
      if (called) return;
      called = true;
      clearTimeout(timer);
      output.removeListener("drain", onDrain);
      done(timedOut);
    };
    if (pendingWrites === 0) return finishDrain(false);
    timer = setTimeout(() => finishDrain(true), STDERR_DRAIN_TIMEOUT_MS);
  } };
}
function supervise({ command, args = [], cwd = process.cwd(), env = process.env, directory = diagnosticsDirectory(), spawnImpl = spawn, parentProcess = process, stderr = process.stderr }) {
  const journal = createJournal(directory);
  const childName = commandName(command);
  journal.append("startup", { childPid: null, command: childName, ppid: process.ppid, runtime: { node: process.versions.node, bun: process.versions.bun ?? null } });
  let child;
  try { child = spawnImpl(command, args, { cwd, env, stdio: ["inherit", "inherit", "pipe"] }); }
  catch (error) { journal.append("spawn-error", { childPid: null, error: safeError(error) }); parentProcess.exitCode = 1; return { journal: journal.file, child: null }; }
  journal.append("spawned", { childPid: child.pid ?? null, command: childName });
  let shutdownRequested = false;
  let exitStatus;
  let parentExit;
  let closeSeen = false;
  let closeStatus;
  let closeTimer;
  let finalized = false;
  const fatalCategories = new Set();
  const drain = forwardStderr(child, stderr, (event, category) => {
    const key = `${event}:${category}`;
    if (fatalCategories.has(key)) return;
    fatalCategories.add(key);
    journal.append(event, { childPid: child.pid ?? null, category });
  });
  const finalize = (drainTimedOut) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(closeTimer);
    const status = closeStatus || exitStatus || { code: child.exitCode ?? null, signal: null };
    journal.append("close", { childPid: child.pid ?? null, code: status.code, signal: status.signal, closeObserved: closeSeen, drainTimedOut });
    if (parentExit !== undefined) parentProcess.exit(parentExit);
  };
  const finishParent = (code) => {
    if (parentExit !== undefined) return;
    parentExit = code;
    if (child.pid === undefined) { drain.close(finalize); return; }
    if (closeSeen) drain.close(finalize);
    else if (exitStatus) {
      closeTimer = setTimeout(() => drain.close(() => finalize(true)), STDERR_DRAIN_TIMEOUT_MS);
    }
  };
  const signalHandlers = new Map();
  const cleanup = () => { for (const [signal, handler] of signalHandlers) parentProcess.removeListener(signal, handler); };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => { shutdownRequested = true; journal.append("signal", { childPid: child.pid ?? null, signal }); };
    signalHandlers.set(signal, handler); parentProcess.on(signal, handler);
  }
  const lifecycleParent = { on: (signal, handler) => parentProcess.on(signal, handler), removeListener: (signal, handler) => parentProcess.removeListener(signal, handler), exit: finishParent };
  const kill = child.kill.bind(child);
  child.kill = (signal) => { if (signal === "SIGKILL") journal.append("force-kill", { childPid: child.pid ?? null, signal, shutdown: shutdownRequested }); return kill(signal); };
  child.once("error", (error) => {
    journal.append("error", { childPid: child.pid ?? null, error: safeError(error) });
    if (child.pid === undefined) cleanup();
  });
  child.once("exit", (code, signal) => {
    exitStatus = { code, signal };
    journal.append("exit", { childPid: child.pid ?? null, code, signal, shutdown: shutdownRequested });
    cleanup();
  });
  child.once("close", (code, signal) => {
    closeSeen = true;
    closeStatus = { code, signal };
    if (parentExit !== undefined) drain.close(finalize);
  });
  wireChildProcessLifecycle(child, lifecycleParent, undefined, (line) => { if (line.includes("could not run the vinext process")) journal.append("spawn-error", { childPid: child.pid ?? null, error: { name: "SpawnError" } }); console.error(line); });
  return { journal: journal.file, child };
}
function main() { const pkgDir = path.resolve(__dirname, ".."); const resolved = resolveVinextCommand(pkgDir); supervise({ command: resolved.command, args: [...resolved.argsPrefix, ...process.argv.slice(2)], cwd: pkgDir }); }
if (require.main === module) main();
module.exports = { createJournal, diagnosticsDirectory, pruneJournals, resolveVinextCommand, safeError, supervise };
