import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createTerminal, getTerminalCwd, hasTerminal, killTerminal, subscribeTerminal, writeTerminal, TerminalOutputQueue, TERMINAL_RECONNECT_MS } = await jiti.import("./terminal-manager.ts");
const { GET } = await jiti.import("../app/api/terminal/[id]/events/route.ts");

/**
 * The Bun PTY backend driven by a fake `Bun` and a fake `process.kill`, so its
 * resize clamp and the signal it sends can be observed without a live terminal.
 */
function runBunBackend(onKill) {
  const resizes = [];
  const signals = [];
  const childSignals = [];
  const source = readFileSync(new URL("./terminal-bun-pty.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const subprocess = {
    pid: 4242,
    exited: new Promise(() => {}),
    exitCode: null,
    kill: (signal) => childSignals.push(signal),
    terminal: {
      closed: false,
      ref() {}, unref() {}, close() {}, setRawMode() {},
      write: () => 0,
      resize: (cols, rows) => resizes.push([cols, rows]),
    },
  };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    Bun: { spawn: () => subprocess },
    process: { kill: (target, signal) => { signals.push([target, signal]); onKill?.(target, signal); } },
    TextDecoder,
  });
  const pty = exports.spawnBunPty("/bin/sh", ["-l"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/", env: {} });
  return { pty, resizes, signals, childSignals };
}

test("native module load failures are deferred until creation and include repair instructions", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, process, require(id) {
    if (id === "node-pty") throw new Error("Cannot find module pty.node");
    return id === "./paths" ? paths : id === "./home-dir" ? { homeDir: () => "/home/terminal" } : require(id);
  } });
  assert.equal(exports.hasTerminal("missing"), false);
  assert.throws(() => exports.createTerminal(process.cwd(), 80, 24), (error) => {
    assert.match(error.message, /native terminal module/);
    assert.match(error.message, /npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts/);
    assert.match(error.message, /Cannot find module pty.node/);
    return true;
  });
});

test("shell environment defaults to UTF-8 locale when the host has none", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./paths") return paths;
    if (id === "./home-dir") return { homeDir: () => "/home/terminal" };
    return require(id);
  };
  const envWithoutLocale = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["LANG", "LC_ALL", "LC_CTYPE"].includes(k)));
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithoutLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.LANG, "C.UTF-8");
});

test("shell environment preserves a case-insensitive Windows locale", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./paths") return paths;
    if (id === "./home-dir") return { homeDir: () => "/home/terminal" };
    return require(id);
  };
  const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["lang", "lc_all", "lc_ctype"].includes(key.toLowerCase())));
  rawEnv.lang = "zh_CN.UTF-8";
  const envWithLocale = new Proxy(rawEnv, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const match = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      return match ? target[match] : undefined;
    },
  });
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.lang, "zh_CN.UTF-8");
  assert.equal("LANG" in spawnCalls[0][2].env, false);
});

test("shell environment omits the web login password", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./paths") return paths;
    if (id === "./home-dir") return { homeDir: () => "/home/terminal" };
    return require(id);
  };
  const env = { ...process.env, PI_WEB_PASSWORD: "web-login-password", PI_USER_SETTING: "preserved" };
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal("PI_WEB_PASSWORD" in spawnCalls[0][2].env, false);
  assert.equal(spawnCalls[0][2].env.PI_USER_SETTING, "preserved");
});

test("native PTY starts after install and repeated creation reuses the same workspace process", (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  assert.ok(record.pty.pid > 0);
  assert.equal(getTerminalCwd(id), process.cwd());
  assert.equal(createTerminal(process.cwd(), 100, 30, id), id);
  assert.strictEqual(globalThis.__piWebTerminals.get(id), record);
  assert.throws(() => createTerminal(process.cwd() + "/other", 80, 24, id), /different workspace/);
  assert.ok(record.cleanupTimer, "unclaimed creations have a lease");
});

test("PTY output keeps flowing after idling, on either terminal backend", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const chunks = [];
  const subscription = subscribeTerminal(id, (event) => {
    if (event.type === "output") chunks.push(event.data);
  });
  // The terminal driver echoes typed input back, so a marker has to be something
  // only the shell prints, and it has to survive an idle gap: a backend that
  // loses the pty master fd after an idle read still echoes keystrokes but
  // never answers a second command.
  const waitFor = async (needle) => {
    for (let attempt = 0; attempt < 100 && !chunks.join("").includes(needle); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return chunks.join("").includes(needle);
  };
  writeTerminal(id, "printf 'pi-web-first:%s\\n' \"$((20+22))\"\r");
  assert.ok(await waitFor("pi-web-first:42"), "expected the first command's output");
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeTerminal(id, "printf 'pi-web-second:%s\\n' \"$((1+1))\"\r");
  assert.ok(await waitFor("pi-web-second:2"), "expected output after idling");
  subscription.unsubscribe();
});

test("Bun's native PTY backend drives an interactive shell like node-pty", async (t) => {
  // node-pty covers this path on Node; the Bun backend only exists under Bun.
  if (typeof Bun === "undefined") return;
  const { spawnBunPty } = await import("./terminal-bun-pty.ts");
  const pty = spawnBunPty("/bin/sh", ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
  });
  t.after(() => pty.kill("SIGKILL"));
  const chunks = [];
  pty.onData((data) => chunks.push(data));
  const waitFor = async (needle) => {
    for (let attempt = 0; attempt < 100 && !chunks.join("").includes(needle); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return chunks.join("").includes(needle);
  };
  pty.write("printf 'pi-web-bun:%s\\n' \"$((20+22))\"\r");
  assert.ok(await waitFor("pi-web-bun:42"), "expected command output over Bun's pty");
  pty.resize(100, 30);
  pty.write("exit 7\r");
  const exit = await new Promise((resolve) => pty.onExit(resolve));
  assert.equal(exit.exitCode, 7);
});

test("Bun's PTY backend clamps a resize before it reallocates the terminal buffer", () => {
  const { pty, resizes } = runBunBackend();
  pty.resize(1e9, 1e9);
  pty.resize(0, 1);
  pty.resize(Number.NaN, 24);
  assert.deepEqual(resizes, [[1000, 1000], [2, 2]]);
});

test("Bun's PTY backend signals the shell's process group", () => {
  const { pty, signals, childSignals } = runBunBackend();
  pty.kill();
  pty.kill("SIGKILL");
  assert.deepEqual(signals, [[-4242, "SIGHUP"], [-4242, "SIGKILL"]]);
  assert.deepEqual(childSignals, []);
});

test("Bun's PTY backend tolerates a group that is already gone, and falls back when it cannot signal one", () => {
  const gone = runBunBackend(() => { throw Object.assign(new Error("no such process group"), { code: "ESRCH" }); });
  gone.pty.kill();
  assert.deepEqual(gone.childSignals, []);

  const unsupported = runBunBackend(() => { throw Object.assign(new Error("unsupported signal"), { code: "ERR_UNKNOWN_SIGNAL" }); });
  unsupported.pty.kill("SIGTERM");
  assert.deepEqual(unsupported.childSignals, ["SIGTERM"]);
});

test("terminal output is merged into frames and released at the cap", () => {
  const queue = new TerminalOutputQueue(8);
  assert.equal(queue.push("one"), "");
  assert.equal(queue.push("two"), "");
  assert.equal(queue.flush(), "onetwo");
  assert.equal(queue.flush(), "");
  assert.equal(queue.push("abcd"), "");
  assert.equal(queue.push("efgh"), "abcd");
  assert.equal(queue.flush(), "efgh");
});

test("a firehose of output reaches the client as merged, bounded frames", async (t) => {
  const id = createTerminal(process.cwd(), 100, 30);
  t.after(() => killTerminal(id, true));
  const frames = [];
  const subscription = subscribeTerminal(id, (event) => {
    if (event.type === "output") frames.push(event.data);
  });
  writeTerminal(id, "yes\r");
  await new Promise((resolve) => setTimeout(resolve, 600));
  killTerminal(id, true);
  subscription.unsubscribe();
  const bytes = frames.reduce((total, frame) => total + frame.length, 0);
  assert.ok(bytes > 50_000, `expected a firehose of output, saw ${bytes} bytes`);
  assert.ok(frames.every((frame) => frame.length <= 64 * 1024), "expected no frame past the cap");
  assert.ok(frames.length < bytes / 2048, `expected merged frames, saw ${frames.length} for ${bytes} bytes`);
});

test("connected terminals outlive the grace period; only the last disconnect starts expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const first = subscribeTerminal(id, () => {});
  const second = subscribeTerminal(id, () => {});
  first.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS * 2);
  assert.ok(hasTerminal(id));
  second.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS - 1);
  assert.ok(hasTerminal(id));
  const resumed = subscribeTerminal(id, () => {});
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.ok(hasTerminal(id));
  resumed.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("unclaimed creations expire without requiring a browser cleanup request", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("SSE resumes from Last-Event-ID and cancellation releases the connection lease", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "old\r\nnew\r\n";
  record.offset = record.backlog.length;
  const request = new Request("http://localhost/events?after=0", { headers: { "Last-Event-ID": "5" } });
  const response = await GET(request, { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  const replay = new TextDecoder().decode((await reader.read()).value);
  assert.match(replay, /id: 10\n/);
  assert.deepEqual(JSON.parse(replay.split("data: ")[1]), { type: "output", data: "new\r\n", offset: 10, reset: false });
  await reader.cancel();
  assert.equal(record.listeners.size, 0);
  assert.ok(record.cleanupTimer);
});

test("expired output cursors reset bounded history, while explicit close ends connected streams", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "tail";
  record.offset = 100;
  const subscription = subscribeTerminal(id, () => {}, 10);
  assert.deepEqual(subscription.output, { type: "output", data: "tail", offset: 100, reset: true });
  subscription.unsubscribe();
  const response = await GET(new Request("http://localhost/events"), { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  killTerminal(id);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"closed"/);
  assert.equal((await reader.read()).done, true);
  assert.equal(record.listeners.size, 0);
  assert.equal(hasTerminal(id), false);
});

/** terminal-manager.ts in a context of its own, with a fake node-pty and the timers and clock the test drives. */
async function sandboxedTerminalManager() {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const clock = { now: 1_000 };
  const timers = new Set();
  const processHandlers = [];
  const exits = [];
  const fakePty = () => ({ onData() {}, onExit(handler) { exits.push(handler); }, write() {}, resize() {}, kill() {} });
  const sandbox = {
    exports: {},
    process: { ...process, env: process.env, platform: process.platform, once: (event) => processHandlers.push(event) },
    require(id) {
      if (id === "node-pty") return { spawn: fakePty };
      if (id === "./home-dir") return { homeDir: () => "/home/terminal" };
      return id === "./paths" ? paths : require(id);
    },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    Date: { now: () => clock.now },
    console,
  };
  runInNewContext(outputText, sandbox);
  // Copied out of the sandbox's realm, so deepEqual compares plain objects.
  const stats = (now) => ({ ...sandbox.exports.getTerminalStats(now) });
  return { exports: sandbox.exports, sandbox, stats, clock, timers, processHandlers, exits };
}

test("terminal stats read a missing registry as empty without creating it or its process handlers", async () => {
  const { sandbox, stats, processHandlers } = await sandboxedTerminalManager();
  assert.deepEqual(stats(), { count: 0, listeners: 0, detached: 0, exited: 0, nextCleanupAt: null });
  assert.equal(sandbox.__piWebTerminals, undefined);
  assert.deepEqual(processHandlers, []);
});

test("terminal stats follow the cleanup deadline, which a reattached stream clears, and touch no timer", async () => {
  const { exports, sandbox, stats, clock, timers, exits } = await sandboxedTerminalManager();
  const id = exports.createTerminal(process.cwd(), 80, 24);
  const record = sandbox.__piWebTerminals.get(id);
  assert.deepEqual(stats(), { count: 1, listeners: 0, detached: 1, exited: 0, nextCleanupAt: 1_000 + TERMINAL_RECONNECT_MS });
  const [unclaimed] = timers;
  assert.deepEqual([...timers], [unclaimed], "reading armed nothing");

  clock.now = 5_000;
  const first = exports.subscribeTerminal(id, () => {});
  assert.equal(record.cleanupAt, null);
  assert.equal(timers.size, 0);
  assert.deepEqual(stats(), { count: 1, listeners: 1, detached: 0, exited: 0, nextCleanupAt: null });
  first.unsubscribe();
  assert.equal(stats().nextCleanupAt, 5_000 + TERMINAL_RECONNECT_MS);

  clock.now = 6_000;
  const second = exports.subscribeTerminal(id, () => {});
  assert.equal(stats().nextCleanupAt, null, "a reattach cancels the cleanup");
  exits[0]({ exitCode: 0 });
  assert.deepEqual(stats(), { count: 1, listeners: 1, detached: 0, exited: 1, nextCleanupAt: null });
  second.unsubscribe();
  assert.equal(stats().nextCleanupAt, 6_000 + TERMINAL_RECONNECT_MS);
  // An overdue deadline reads as now: the timer fires on the next turn of the loop.
  assert.equal(stats(6_000 + TERMINAL_RECONNECT_MS + 500).nextCleanupAt, 6_000 + TERMINAL_RECONNECT_MS + 500);

  // A record created before a hot reload has no cleanupAt.
  sandbox.__piWebTerminals.set("older", { listeners: new Set([() => {}]), exited: false, exitCode: null, cleanupTimer: null });
  assert.deepEqual(stats(), { count: 2, listeners: 1, detached: 1, exited: 1, nextCleanupAt: 6_000 + TERMINAL_RECONNECT_MS });
  assert.equal(timers.size, 1);

  exports.killTerminal(id);
  assert.equal(record.cleanupAt, null);
  assert.deepEqual(stats(), { count: 1, listeners: 1, detached: 0, exited: 0, nextCleanupAt: null });
});
