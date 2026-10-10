import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
];

test("configures HTTP_PROXY, HTTPS_PROXY, and NO_PROXY for global fetch", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];

  const connectTargets = [];
  const forwardedRequests = [];
  const proxy = createServer((req, res) => {
    forwardedRequests.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  t.after(async () => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve, reject) => {
      proxy.close((error) => error ? reject(error) : resolve());
    });
  });

  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = `http://127.0.0.1:${address.port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.NO_PROXY = "bypass.invalid";

  const jiti = createJiti(import.meta.url);
  const { configureHttpDispatcher } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  assert.throws(() => configureHttpDispatcher(-1), /Invalid HTTP idle timeout/);
  configureHttpDispatcher(2_000);

  const dispatcher = getGlobalDispatcher();
  configureHttpDispatcher(5_000);
  assert.equal(getGlobalDispatcher(), dispatcher, "configuration should be idempotent");

  // Bun's fetch takes its proxy from the request or from $HTTP_PROXY / $HTTPS_PROXY and
  // never from a global dispatcher, and the `undici` Bun loads exposes no `install` to point
  // global fetch at one with, so `configureHttpDispatcher()` is a documented no-op there (see
  // the guard in lib/http-dispatcher.ts). Assert that contract instead of skipping the file:
  // the routing below can only be observed where a dispatcher is what fetch consults.
  if (typeof Bun !== "undefined") {
    configureHttpDispatcher(2_000);
    assert.equal(getGlobalDispatcher(), dispatcher, "Bun installs no dispatcher");
    return;
  }

  const httpResponse = await fetch("http://target.invalid/through-http-proxy", {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(httpResponse.status, 204);
  assert.deepEqual(forwardedRequests, ["GET http://target.invalid/through-http-proxy"]);
  assert.deepEqual(connectTargets, []);

  await assert.rejects(fetch("https://target.invalid/through-https-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.deepEqual(connectTargets, ["target.invalid:443"]);

  const forwardedRequestCount = forwardedRequests.length;
  const connectTargetCount = connectTargets.length;
  await assert.rejects(fetch("http://bypass.invalid:9/no-proxy", {
    signal: AbortSignal.timeout(2_000),
  }));
  assert.equal(forwardedRequests.length, forwardedRequestCount);
  assert.equal(connectTargets.length, connectTargetCount);
});

test("reads httpIdleTimeoutMs from the agent settings file", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-http-idle-"));
  const settingsPath = join(agentDir, "settings.json");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const jiti = createJiti(import.meta.url);
  const { readHttpIdleTimeoutMs } = await jiti.import("./http-dispatcher.ts");

  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "no settings file keeps the default");

  writeFileSync(settingsPath, "{ not json");
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "unparsable settings keep the default");

  writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a settings file without the key keeps the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: -1 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a value the CLI rejects keeps the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: null }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "a null value keeps the default");

  writeFileSync(settingsPath, JSON.stringify(["httpIdleTimeoutMs"]));
  assert.equal(readHttpIdleTimeoutMs(agentDir), undefined, "settings that are not an object keep the default");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: 1_200_000 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 1_200_000, "the configured timeout is used");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: 0 }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 0, "0 disables the timeout");

  writeFileSync(settingsPath, JSON.stringify({ httpIdleTimeoutMs: "disabled" }));
  assert.equal(readHttpIdleTimeoutMs(agentDir), 0, "the CLI's disabled spelling disables the timeout");

  writeFileSync(settingsPath, `\ufeff${JSON.stringify({ httpIdleTimeoutMs: 900_000 })}`);
  assert.equal(readHttpIdleTimeoutMs(agentDir), 900_000, "a byte-order mark is allowed");

  // Without an argument the agent directory comes from pi's own override.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  assert.equal(readHttpIdleTimeoutMs(), 900_000, "PI_CODING_AGENT_DIR picks the directory");
});

test("resolves PI_CODING_AGENT_DIR as pi's getAgentDir() does", async (t) => {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const jiti = createJiti(import.meta.url);
  const { defaultAgentDir } = await jiti.import("./http-dispatcher.ts");

  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  // $HOME is pinned to the folder the runtime's own user database reports, because the SDK
  // resolves home with `os.homedir()` and Bun's ignores $HOME: with a relocated $HOME this
  // comparison would measure the fork's rule (`lib/home-dir.ts`) instead of pi's. What that
  // rule does on a relocated home is the test below.
  const previousHome = process.env.HOME;
  process.env.HOME = homedir();
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  for (const value of [undefined, "", "~", "~/agent", "~\\agent", "/abs/agent", "rel/agent", " /padded ", "file:///tmp/agent", "/c/Users/agent", "/mnt/d/agent"]) {
    if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = value;
    assert.equal(defaultAgentDir(), getAgentDir(), `PI_CODING_AGENT_DIR=${JSON.stringify(value)}`);
  }
});

test("a relocated $HOME moves the agent dir the idle timeout is read from", async (t) => {
  const jiti = createJiti(import.meta.url);
  const { defaultAgentDir, readHttpIdleTimeoutMs } = await jiti.import("./http-dispatcher.ts");

  const home = mkdtempSync(join(tmpdir(), "pi-web-http-home-"));
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 1_500 }));

  const previous = { HOME: process.env.HOME, AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  // Node's `os.homedir()` honours $HOME and Bun's reads the user database, so on Bun this is
  // the whole difference between `homeDir()` and the runtime: without it the settings file is
  // looked for in the account's home and the configured timeout is silently the default.
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  assert.equal(defaultAgentDir(), agentDir, "$HOME is the home the app resolves");
  assert.equal(readHttpIdleTimeoutMs(), 1_500, "so the global settings file is the relocated one");

  process.env.PI_CODING_AGENT_DIR = "~";
  assert.equal(defaultAgentDir(), home, "`~` expands to $HOME");
  process.env.PI_CODING_AGENT_DIR = "~/agent";
  assert.equal(defaultAgentDir(), join(home, "agent"), "`~/…` expands to $HOME");
});
