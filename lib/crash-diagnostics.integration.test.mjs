import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { runStripped } from "./__fixtures__/strip-types.mjs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tryNative: false, tsconfigPaths: true });
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const { installRuntimeDiagnostics } = await jiti.import("./runtime-diagnostics.ts");

for (const mode of ["reject", "deadline"]) {
  test(`shutdown ${mode} persists its outcome before a zero exit`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-shutdown-journal-"));
    const diagnostics = installRuntimeDiagnostics({ directory });
    t.after(() => {
      diagnostics.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const handlers = new Map();
    let deadline;
    let exitCode;
    const context = vm.createContext({
      exports: {}, console: { log() {}, warn() {} },
      setTimeout(callback) { deadline = callback; return { unref() {} }; },
      clearTimeout() {},
      process: {
        on(event, listener) { handlers.set(event, listener); },
        exit(code) { exitCode = code; },
      },
    });
    const source = fs.readFileSync(new URL("./server-shutdown.ts", import.meta.url), "utf8");
    runStripped(source, context);
    const runtime = await jiti.import("./runtime-diagnostics.ts");
    context.exports.subscribeShutdownOutcome((outcome) => runtime.recordRuntimeDiagnostic("shutdown", outcome));
    context.exports.onServerShutdown(() => mode === "reject" ? Promise.reject(new Error("private-failure")) : new Promise(() => {}));
    handlers.get("SIGTERM")();
    await new Promise(setImmediate);
    if (mode === "deadline") deadline();
    assert.equal(exitCode, 0);
    const files = fs.readdirSync(directory);
    const rows = files.filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n").map(JSON.parse));
    const outcome = rows.filter((row) => row.event === "shutdown").at(-1);
    assert.equal(outcome.phase, mode === "reject" ? "completed" : "deadline");
    assert.equal(outcome.graceful, false);
    assert.equal(outcome.rejectedCleanups, mode === "reject" ? 1 : 0);
    const marker = files.find((file) => file.endsWith(".run.json"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, marker), "utf8")).state, "failed");
    assert.ok(!JSON.stringify(rows).includes("private-failure"));
  });
}

test("every backlog termination reaches disk despite console rate limiting", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-crash-bridge-"));
  const diagnostics = installRuntimeDiagnostics({ directory });
  const previousLimit = process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
  process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
  t.after(() => {
    diagnostics.dispose();
    if (previousLimit === undefined) delete process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES;
    else process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES = previousLimit;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 2; index++) {
    const abortController = new AbortController();
    t.after(() => abortController.abort());
    let listener;
    let unsubscribed = false;
    const stream = createAgentEventStream(
      new Request("http://localhost/events", { signal: abortController.signal }),
      `diagnostic-backlog-${index}`,
      Promise.resolve({
        isStreaming: true,
        streamingMessage: undefined,
        onEvent(nextListener) {
          listener = nextListener;
          return () => { unsubscribed = true; };
        },
      }),
    );
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    listener({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "private-content".repeat(50_000) }] } });
    listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "later" } });
    await assert.rejects(reader.read(), /client backlog exceeded/);
    assert.equal(unsubscribed, true);
  }

  const rows = fs.readdirSync(directory).filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => fs.readFileSync(path.join(directory, file), "utf8").trim().split("\n").map(JSON.parse));
  const closures = rows.filter((row) => row.event === "backpressure" && row.action === "close");
  assert.equal(closures.length, 2);
  assert.ok(closures.every((row) => row.queuedBytes > 64 * 1024));
  assert.ok(rows.filter((row) => row.event === "sample").length >= 3);
  assert.ok(!JSON.stringify(rows).includes("private-content"));
});
