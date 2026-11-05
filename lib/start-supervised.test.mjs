import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import test, { after } from "node:test";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";

const require = createRequire(import.meta.url);
const { createJournal, resolveVinextCommand, safeError, supervise } = require("../bin/start-supervised.cjs");

const directories = new Set();
function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-supervisor-"));
  directories.add(directory);
  return directory;
}
after(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});
function parentProcess() {
  const parent = new EventEmitter();
  parent.exit = (code) => { parent.exitCode = code; };
  return parent;
}
async function waitForExit(parent) {
  for (let i = 0; i < 500 && parent.exitCode === undefined; i++) await delay(10);
  assert.notEqual(parent.exitCode, undefined, "supervisor parent did not receive child exit");
}
function journalEntries(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("records fatal stderr categories while forwarding output and waits for close", async () => {
  const dir = tempDir();
  const parent = parentProcess();
  const stderr = new PassThrough();
  let forwarded = "";
  stderr.on("data", (chunk) => { forwarded += chunk.toString(); });
  const result = supervise({
    command: process.execPath,
    args: ["-e", "process.stderr.write('FATAL ERROR: heap out of memory\\nprivate/path'); process.exit(9)"],
    directory: dir,
    parentProcess: parent,
    stderr,
  });
  await waitForExit(parent);
  const entries = journalEntries(result.journal);
  assert.equal(entries.find((entry) => entry.event === "fatal-stderr").category, "heap-out-of-memory");
  assert.match(forwarded, /FATAL ERROR: heap out of memory/);
  assert.doesNotMatch(fs.readFileSync(result.journal, "utf8"), /private\/path|heap out of memory/);
  assert.equal(entries.find((entry) => entry.event === "exit").code, 9);
  assert.equal(entries.find((entry) => entry.event === "close").code, 9);
});

test("forwards ordinary stderr without classifying it as fatal", async () => {
  const dir = tempDir();
  const parent = parentProcess();
  const stderr = new PassThrough();
  let forwarded = "";
  stderr.on("data", (chunk) => { forwarded += chunk.toString(); });
  const result = supervise({ command: process.execPath, args: ["-e", "process.stderr.write('ordinary warning\\n'); process.exit(0)"], directory: dir, parentProcess: parent, stderr });
  await waitForExit(parent);
  assert.match(forwarded, /ordinary warning/);
  assert.equal(journalEntries(result.journal).some((entry) => entry.event === "fatal-stderr"), false);
});

test("records raw exit code 9 and preserves extra flags", async () => {
  const dir = tempDir();
  const parent = parentProcess();
  const result = supervise({
    command: process.execPath,
    args: ["-e", "if (process.argv[1] !== \"extra-flag\") process.exit(7); process.exit(9)", "extra-flag"],
    directory: dir,
    parentProcess: parent,
  });
  await waitForExit(parent);
  const entries = journalEntries(result.journal);
  assert.equal(entries.find((entry) => entry.event === "exit").code, 9);
  assert.equal(entries.find((entry) => entry.event === "exit").signal, null);
  assert.equal(entries.find((entry) => entry.event === "spawned").childPid > 0, true);
});

test("records a child hard kill without losing the journal", async () => {
  const dir = tempDir();
  const parent = parentProcess();
  const result = supervise({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], directory: dir, parentProcess: parent });
  result.child.kill("SIGKILL");
  await waitForExit(parent);
  const exit = journalEntries(result.journal).find((entry) => entry.event === "exit");
  assert.equal(exit.code, null);
  assert.equal(exit.signal, "SIGKILL");
});

test("forwards shutdown and removes signal listeners after exit", async () => {
  const dir = tempDir();
  const parent = parentProcess();
  const result = supervise({
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    directory: dir,
    parentProcess: parent,
  });
  parent.emit("SIGTERM");
  await waitForExit(parent);
  const entries = journalEntries(result.journal);
  assert.equal(entries.find((entry) => entry.event === "signal").signal, "SIGTERM");
  assert.equal(parent.listenerCount("SIGTERM"), 0);
});

test("fallback resolves and starts the fixture CLI with the original runtime", async () => {
  const pkgDir = tempDir();
  const cli = path.join(pkgDir, "node_modules", "vinext", "dist", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "if (process.argv.includes('fixture-flag')) process.exit(9); process.exit(4);\n");
  fs.mkdirSync(path.join(pkgDir, "node_modules", ".bin"));
  fs.writeFileSync(path.join(pkgDir, "node_modules", ".bin", "vinext.bunx"), "metadata, not an executable");
  const resolved = resolveVinextCommand(pkgDir, process.platform, process.execPath);
  assert.equal(resolved.fallback, true);
  const parent = parentProcess();
  const result = supervise({ command: resolved.command, args: [...resolved.argsPrefix, "fixture-flag"], directory: tempDir(), parentProcess: parent });
  await waitForExit(parent);
  assert.equal(journalEntries(result.journal).find((entry) => entry.event === "exit").code, 9);
});

test("a blocked diagnostics directory does not prevent spawning", async () => {
  const dir = path.join(tempDir(), "blocked");
  fs.writeFileSync(dir, "not a directory");
  const parent = parentProcess();
  const stderr = new PassThrough();
  stderr.resume();
  const result = supervise({ command: process.execPath, args: ["-e", "process.stderr.write('panic: private-path\\n'); process.exit(0)"], directory: dir, parentProcess: parent, stderr });
  await waitForExit(parent);
  assert.equal(parent.exitCode, 0);
  assert.equal(result.journal, undefined);
});

test("retention protects live and unknown supervisors while reserving the current slot", () => {
  const dir = tempDir();
  const livePid = process.pid;
  for (let i = 0; i < 20; i++) {
    const pid = i === 0 ? livePid : 400000000 + i;
    fs.writeFileSync(path.join(dir, `supervisor-${pid}-${i}-${randomUUID()}.jsonl`), "x\n");
  }
  createJournal(dir);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith(`supervisor-${livePid}-`)));
  assert.ok(fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).length <= 16);
});

test("the journal reserves space for the final status after noisy signals", () => {
  const journal = createJournal(tempDir());
  for (let index = 0; index < 2000; index++) journal.append("signal", { signal: "SIGTERM" });
  journal.append("exit", { code: 9, signal: null });
  assert.equal(journalEntries(journal.file).at(-1).event, "exit");
  assert.ok(fs.statSync(journal.file).size <= 64 * 1024);
});

test("bounds exit-to-close waiting when an inherited pipe never closes", async () => {
  const parent = parentProcess();
  const child = new EventEmitter();
  child.pid = 123;
  child.kill = () => true;
  const result = supervise({ command: process.execPath, directory: tempDir(), parentProcess: parent, spawnImpl: () => child });
  child.emit("exit", 9, null);
  assert.equal(parent.exitCode, undefined);
  await waitForExit(parent);
  const close = journalEntries(result.journal).find((entry) => entry.event === "close");
  assert.equal(parent.exitCode, 9);
  assert.equal(close.closeObserved, false);
  assert.equal(close.drainTimedOut, true);
});

test("bounds blocked output drain and retains final stderr markers", async () => {
  const parent = parentProcess();
  const stderr = new Writable({ highWaterMark: 1, write() { /* Intentionally blocked. */ } });
  const result = supervise({ command: process.execPath, args: ["-e", "process.stderr.write('panic: private-path\\n'); process.exit(9)"], directory: tempDir(), parentProcess: parent, stderr });
  await waitForExit(parent);
  const entries = journalEntries(result.journal);
  assert.equal(entries.filter((entry) => entry.event === "fatal-stderr").length, 1);
  assert.equal(entries.find((entry) => entry.event === "close").drainTimedOut, true);
  assert.doesNotMatch(fs.readFileSync(result.journal, "utf8"), /private-path/);
  stderr.destroy();
});

test("spawn failure does not wait for a close event", () => {
  const parent = parentProcess();
  const child = new EventEmitter();
  child.kill = () => true;
  supervise({ command: process.execPath, directory: tempDir(), parentProcess: parent, spawnImpl: () => child });
  child.emit("error", Object.assign(new Error("private-path"), { code: "ENOENT" }));
  assert.equal(parent.exitCode, 1);
});

test("spawn diagnostics strip messages and arbitrary identity strings", () => {
  assert.deepEqual(safeError({ name: "private-token", code: "private-token", message: "private-token" }), { name: "Error", code: undefined });
  assert.deepEqual(safeError({ name: "Error", code: "ENOENT", message: "private-path" }), { name: "Error", code: "ENOENT" });
});
