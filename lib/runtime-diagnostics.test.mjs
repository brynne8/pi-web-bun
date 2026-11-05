import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, tsconfigPaths: true });
const { installRuntimeDiagnostics, collectRuntimeCounts, sanitizeRuntimeError, recordRuntimeDiagnostic, runtimeDiagnosticsDirectory } = await jiti.import("./runtime-diagnostics.ts");
const source = readFileSync(new URL("./runtime-diagnostics.ts", import.meta.url), "utf8");
const compiled = jiti.transform({ source, filename: "runtime-diagnostics.ts", ts: true });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-diagnostics-"));
  t.after(() => {
    globalThis[Symbol.for("pi-web.runtimeDiagnostics")]?.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function records(directory) {
  return readdirSync(directory).filter(name => /\.jsonl(?:\.\d+)?$/.test(name))
    .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
}
function run(directory, script) {
  const moduleFile = join(directory, "diagnostics.cjs");
  writeFileSync(moduleFile, compiled);
  const childFile = join(directory, "child.cjs");
  writeFileSync(childFile, `const { installRuntimeDiagnostics } = require(${JSON.stringify(moduleFile)});\nconst diagnostics = installRuntimeDiagnostics({directory: ${JSON.stringify(directory)}});\n${script}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const deadline = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("diagnostics held child open")); }, 4000);
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stderr }); });
  });
}

test("resolves the diagnostic directory without loading the SDK", () => {
  const home = join(tmpdir(), "diagnostics-home");
  assert.equal(runtimeDiagnosticsDirectory("", home), join(home, ".pi", "agent", "pi-web", "diagnostics"));
  assert.equal(runtimeDiagnosticsDirectory("~", home), join(home, "pi-web", "diagnostics"));
  assert.equal(runtimeDiagnosticsDirectory("~/agent", home), join(home, "agent", "pi-web", "diagnostics"));
  assert.equal(runtimeDiagnosticsDirectory("~\\agent", home), join(home, "agent", "pi-web", "diagnostics"));
});

test("persists samples and sanitizes collector output; install and dispose are idempotent", t => {
  const directory = fixture(t);
  const before = ["warning", "exit", "uncaughtExceptionMonitor", "unhandledRejection"].map(event => process.listenerCount(event));
  const diagnostics = installRuntimeDiagnostics({ directory, collect: () => ({ rpcSessions: 2, startLocks: 3, sseStreams: 4, prompt: "secret" }) });
  t.after(() => diagnostics.dispose());
  assert.equal(installRuntimeDiagnostics({ directory }), diagnostics);
  diagnostics.sample();
  const rows = records(directory);
  assert.equal(rows.filter(row => row.event === "startup").length, 1);
  const sample = rows.find(row => row.event === "sample");
  assert.deepEqual(sample.counts, { rpcSessions: 2, startLocks: 3, sseStreams: 4, running: 0, closing: 0, compacting: 0, subagents: 0, sseQueuedBytes: 0, sseDroppedEvents: 0 });
  const startup = rows.find(row => row.event === "startup");
  assert.equal(startup.ppid, process.ppid);
  assert.match(startup.executableBasename, /^[A-Za-z0-9_.-]{1,80}$/);
  assert.ok(sample.memory.systemTotalBytes > 0);
  assert.ok(sample.cpuTimeMicros.user >= 0);
  assert.ok(sample.cpuTimeMicros.system >= 0);
  assert.ok(sample.memory.rss > 0);
  assert.ok(sample.memory.maxRssBytes > 0);
  assert.ok(sample.memory.systemFreeBytes >= 0);
  assert.ok(sample.timestamp);
  assert.equal(sample.pid, process.pid);
  assert.ok(!JSON.stringify(rows).includes("secret"));
  diagnostics.stop();
  diagnostics.dispose();
  assert.deepEqual(["warning", "exit", "uncaughtExceptionMonitor", "unhandledRejection"].map(event => process.listenerCount(event)), before);
  const restarted = installRuntimeDiagnostics({ directory });
  assert.notEqual(restarted, diagnostics);
  restarted.dispose();
});

test("rotates real JSONL files and bounds each run", t => {
  const directory = fixture(t);
  const diagnostics = installRuntimeDiagnostics({ directory, maxBytes: 1024, archives: 2 });
  t.after(() => diagnostics.dispose());
  for (let i = 0; i < 40; i++) diagnostics.sample();
  const files = readdirSync(directory).filter(name => name.includes(".jsonl"));
  assert.equal(files.length, 3);
  for (const file of files) assert.ok(statSync(join(directory, file)).size <= 1024);
  assert.ok(records(directory).some(row => row.event === "sample"));
});

test("restart distinguishes dead unfinished runs from live PIDs and bounds retention", async t => {
  const directory = fixture(t);
  const result = await run(directory, 'process.kill(process.pid, "SIGKILL");');
  assert.ok(result.code !== 0 || result.signal !== null);
  const oldRun = readdirSync(directory).find(name => name.endsWith(".run.json"));
  assert.equal(JSON.parse(readFileSync(join(directory, oldRun), "utf8")).state, "running");
  const liveName = `run-${process.pid}-1-00000000-0000-0000-0000-000000000000.run.json`;
  writeFileSync(join(directory, liveName), JSON.stringify({ state: "running" }));
  const diagnostics = installRuntimeDiagnostics({ directory, retainedRuns: 1 });
  t.after(() => diagnostics.dispose());
  const startup = records(directory).find(row => row.event === "startup");
  assert.equal(startup.previous.unclean, 1);
  assert.equal(startup.previous.active, 1);
  assert.ok(readdirSync(directory).includes(liveName));
  assert.ok(!readdirSync(directory).includes(oldRun));
});

test("restart recognizes an observed normal exit", async t => {
  const directory = fixture(t);
  assert.equal((await run(directory, "")).code, 0);
  const diagnostics = installRuntimeDiagnostics({ directory });
  t.after(() => diagnostics.dispose());
  const startups = records(directory).filter(row => row.event === "startup");
  assert.ok(startups.some(row => row.previous.exited === 1 && row.previous.unclean === 0));
});

test("a zero exit does not overwrite an incomplete shutdown marker", async t => {
  const directory = fixture(t);
  const result = await run(directory, 'diagnostics.record({event:"shutdown",signal:"SIGTERM",phase:"deadline",graceful:false}); process.exit(0);');
  assert.equal(result.code, 0);
  const marker = readdirSync(directory).find(name => name.endsWith(".run.json"));
  assert.equal(JSON.parse(readFileSync(join(directory, marker), "utf8")).state, "failed");
});

test("fatal monitor preserves uncaught exception and rejection termination", async t => {
  for (const script of ['setImmediate(() => { throw new Error("private/path/token"); });', 'Promise.reject(new Error("private/path/token"));']) {
    const directory = fixture(t);
    const result = await run(directory, script);
    assert.notEqual(result.code, 0, result.stderr);
    const rows = records(directory);
    // Bun currently terminates rejected promises without emitting the monitor event.
    if (!process.versions.bun || script.startsWith("setImmediate")) {
      const fatal = rows.find(row => row.event === "fatal");
      assert.ok(fatal, result.stderr);
      assert.equal(fatal.exception.name, "Error");
      assert.ok(fatal.exception.frames.some(frame => frame.file === "child.cjs"));
    }
    assert.ok(!JSON.stringify(rows).includes("private/path/token"));
    if (!process.versions.bun || script.startsWith("setImmediate")) {
      assert.ok(!readdirSync(directory).filter(name => name.endsWith(".run.json")).some(name => JSON.parse(readFileSync(join(directory, name), "utf8")).state === "exited"));
    }
  }
});

test("unref timer permits natural exit and warnings persist without message data", async t => {
  const directory = fixture(t);
  const result = await run(directory, 'process.emitWarning("private/path/token", {type: "DeprecationWarning", code: "DEP0123"});');
  assert.equal(result.code, 0, result.stderr);
  const rows = records(directory);
  assert.ok(rows.some(row => row.event === "warning" && row.name === "DeprecationWarning" && row.code === "DEP0123"));
  assert.ok(rows.some(row => row.event === "exit"));
  assert.ok(!JSON.stringify(rows).includes("private/path/token"));
});

test("unwritable journal warns once with errno only and never throws", t => {
  const directory = fixture(t);
  const blocked = join(directory, "private-path-token");
  writeFileSync(blocked, "not a directory");
  const original = console.warn;
  const warnings = [];
  console.warn = text => warnings.push(text);
  try {
    const diagnostics = installRuntimeDiagnostics({ directory: blocked });
    assert.doesNotThrow(() => { diagnostics.sample(); diagnostics.sample(); diagnostics.dispose(); });
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[pi-web\] runtime diagnostics storage unavailable \((E[A-Z0-9_]+|UNKNOWN)\)$/);
  assert.ok(!warnings[0].includes("private-path-token"));
});

test("collector exceptions and throwing fields preserve memory samples", t => {
  const directory = fixture(t);
  let mode = "throw";
  const diagnostics = installRuntimeDiagnostics({ directory, collect: () => {
    if (mode === "throw") throw new Error("secret");
    return { rpcSessions: 3, get running() { throw new Error("secret"); }, sseStreams: 2 };
  } });
  mode = "fields";
  diagnostics.sample();
  const samples = records(directory).filter(row => row.event === "sample");
  assert.equal(samples.length, 2);
  assert.equal(samples[0].collectorFailed, true);
  assert.ok(samples[0].memory.rss > 0);
  assert.equal(samples[1].counts.rpcSessions, 3);
  assert.equal(samples[1].counts.running, 0);
  assert.equal(samples[1].counts.sseStreams, 2);
  assert.ok(!JSON.stringify(samples).includes("secret"));
});

test("exception identity and stack frames are useful, bounded and path free", () => {
  const error = {
    name: "TypeError", code: "ENOMEM",
    stack: "TypeError: secret /private/credentials\n" +
      "    at privateFunction (/private/token/worker.ts:123:45)\n" +
      "    at C:\\private\\credential\\server.cjs:9:2\n" +
      "    at bad (/private/name?secret.js:1:2)\n" +
      Array(30).fill("    at fn (file:///private/runtime.mjs:8:3)").join("\n"),
  };
  const identity = sanitizeRuntimeError(error);
  assert.equal(identity.name, "TypeError");
  assert.equal(identity.code, "ENOMEM");
  assert.equal(identity.frames.length, 8);
  assert.deepEqual(identity.frames.slice(0, 2), [{ file: "worker.ts", line: 123, column: 45 }, { file: "server.cjs", line: 9, column: 2 }]);
  assert.ok(!JSON.stringify(identity).match(/secret|private|credential|privateFunction/));
  assert.deepEqual(sanitizeRuntimeError({ name: "token-name", code: "secret" }), { name: "OtherError", code: null, frames: [] });
  assert.doesNotThrow(() => sanitizeRuntimeError(new Proxy({}, { get() { throw new Error(); } })));
});

test("aggregate getters isolate stale wrappers and never call liveness providers", t => {
  const keys = ["__piSessions", "__piStartLocks", Symbol.for("pi-web.agentEventStreamClosers"), Symbol.for("pi-web.agentEventStreamInfos")];
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => keys.forEach((key, index) => {
    if (originals[index]) Object.defineProperty(globalThis, key, originals[index]);
    else delete globalThis[key];
  }));
  let livenessCalls = 0;
  globalThis.__piSessions = new Map([
    ["private/id", { isAlive() { livenessCalls++; throw new Error(); }, getDebugSnapshot: () => ({ state: "closing", subagent: true, run: { running: true, compacting: true } }) }],
    ["stale", { getDebugSnapshot() { throw new Error(); } }],
    ["partial", { getDebugSnapshot: () => ({ state: "alive", run: { running: true } }) }],
  ]);
  globalThis.__piStartLocks = new Map([["secret", {}]]);
  globalThis[keys[2]] = new Set([1, 2]);
  globalThis[keys[3]] = new Map([
    [1, { queuedBytes: () => 42, droppedEvents: () => 5 }],
    [2, { queuedBytes() { throw new Error(); }, droppedEvents: () => 2 }],
    [3, { queuedBytes: () => -10, droppedEvents: () => NaN }],
  ]);
  assert.deepEqual(collectRuntimeCounts(), { rpcSessions: 3, startLocks: 1, sseStreams: 2, running: 2, closing: 1, compacting: 1, subagents: 1, sseQueuedBytes: 42, sseDroppedEvents: 7 });
  assert.equal(livenessCalls, 0);
});

test("targeted lifecycle schema strips payloads and validates shutdown signals", t => {
  const directory = fixture(t);
  assert.doesNotThrow(() => recordRuntimeDiagnostic("session-start", {}));
  const diagnostics = installRuntimeDiagnostics({ directory });
  recordRuntimeDiagnostic("session-start", { subagent: true, sessionId: "secret" });
  recordRuntimeDiagnostic("session-closed", { prompt: "secret" });
  recordRuntimeDiagnostic("backpressure", { action: "drop", queuedBytes: 123, droppedEvents: 4, path: "secret" });
  recordRuntimeDiagnostic("shutdown", { signal: "SIGTERM", auth: "secret" });
  recordRuntimeDiagnostic("shutdown", { phase: "completed", signal: "SIGTERM", graceful: true });
  recordRuntimeDiagnostic("shutdown", { phase: "started", signal: "secret" });
  recordRuntimeDiagnostic("unknown", { value: "secret" });
  const rows = records(directory);
  assert.equal(rows.filter(row => row.event === "shutdown").length, 2);
  assert.equal(rows.filter(row => row.event === "sample").length, 6);
  const validEvents = new Set(["session-start", "session-closed", "backpressure", "shutdown"]);
  rows.forEach((row, index) => {
    if (validEvents.has(row.event)) assert.equal(rows[index + 1]?.event, "sample");
  });
  assert.ok(rows.some(row => row.event === "shutdown" && row.signal === "SIGTERM" && row.graceful === true));
  assert.ok(rows.some(row => row.event === "backpressure" && row.queuedBytes === 123));
  assert.ok(!JSON.stringify(rows).includes("secret"));
  diagnostics.dispose();
  recordRuntimeDiagnostic("session-start", {});
});
