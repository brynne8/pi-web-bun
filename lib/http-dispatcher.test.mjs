import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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

test("leaves the global fetch and Request classes alone", async (t) => {
  const originalRequest = globalThis.Request;
  const originalFetch = globalThis.fetch;

  const { configureHttpDispatcher } = await import("./http-dispatcher.ts");

  // Another test in this file configures the dispatcher already, and the guard
  // would make this call a no-op; clear it so the classes are really re-bound.
  const guard = globalThis.__piWebHttpDispatcher;
  globalThis.__piWebHttpDispatcher = undefined;
  t.after(() => {
    globalThis.__piWebHttpDispatcher = guard;
  });

  configureHttpDispatcher(1_000);

  // Swapping them for undici's own copies (undici.install()) leaves a server
  // that already bound the built-in classes unable to read the requests the
  // swapped ones create: "Failed to parse URL from [object Request]".
  assert.equal(globalThis.Request, originalRequest);
  assert.equal(globalThis.fetch, originalFetch);
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("configures HTTP_PROXY, HTTPS_PROXY, and NO_PROXY for global fetch", async (t) => {
  // Under Bun no dispatcher serves fetch at all, so this measures a dispatcher Node alone
  // installs; the fork's own contract there is the environment write asserted below.
  if (typeof Bun !== "undefined") return;
  const connectTargets = [];
  const proxy = createServer((_req, res) => res.end("direct"));
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  const proxyUrl = await listen(t, proxy);
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) delete env[key];

  // Both startup paths install a process-wide dispatcher. Give this one a fresh process.
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createJiti } from "jiti";
    const { configureHttpDispatcher } = await createJiti(import.meta.url).import("./http-dispatcher.ts");
    configureHttpDispatcher(2_000);
    for (const url of ["http://target.invalid", "https://target.invalid"]) {
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2_000) }));
    }
    const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(2_000) });
    assert.equal(await response.text(), "direct");
  `, proxyUrl], {
    cwd: new URL(".", import.meta.url),
    env: { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "127.0.0.1", NODE_USE_ENV_PROXY: "0" },
  });
  assert.deepEqual(connectTargets, ["target.invalid:80", "target.invalid:443"]);
});

test("global fetch switches proxies without interrupting a stream and honors HTTP_PROXY, HTTPS_PROXY, and NO_PROXY", async (t) => {
  const originalEnv = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let stream;
  const origin = createServer((req, res) => {
    res.setHeader("Connection", "close");
    if (req.url === "/stream") {
      stream = res;
      res.write("first");
    } else {
      res.end("ok");
    }
  });
  const originUrl = await listen(t, origin);
  const originHost = new URL(originUrl).host;
  const connectTargets = [];
  const forwardedRequests = [];
  async function startProxy(name) {
    const proxy = createServer((req, res) => {
      forwardedRequests.push(`${req.method} ${req.url}`);
      res.writeHead(204, { Connection: "close" });
      res.end();
    });
    proxy.on("connect", (req, socket) => {
      connectTargets.push([name, req.url]);
      if (req.url === originHost) {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        origin.emit("connection", socket);
      } else {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
    return listen(t, proxy);
  }
  const proxyA = await startProxy("A");
  const proxyB = await startProxy("B");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-http-proxy-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 2_000, httpProxy: proxyA }));

  const jiti = createJiti(import.meta.url);
  const { configureHttpDispatcher, configureHttpDispatcherFromSettings, setHttpProxy } = await jiti.import("./http-dispatcher.ts");
  const { getGlobalDispatcher } = await import("undici");

  // One globalThis serves the whole suite on Bun, so a file that ran earlier may have installed
  // this process's HTTP behaviour already; that would make every call below a no-op. This test
  // measures a configuration it makes itself, so it starts from an unconfigured process and puts
  // back what it found.
  const previousInstall = globalThis.__piWebHttpDispatcher;
  globalThis.__piWebHttpDispatcher = undefined;
  t.after(() => {
    globalThis.__piWebHttpDispatcher = previousInstall;
  });

  assert.throws(() => configureHttpDispatcher(-1), /Invalid HTTP idle timeout/);
  configureHttpDispatcherFromSettings(agentDir);

  const dispatcher = getGlobalDispatcher();
  configureHttpDispatcher(5_000);
  assert.equal(getGlobalDispatcher(), dispatcher, "configuration should be idempotent");

  // Bun's fetch is Bun's own HTTP client: it takes its proxy from the environment as a request
  // starts and never consults a global dispatcher, and the `undici` Bun loads exposes no
  // `install` to point fetch at one with (lib/http-dispatcher.ts). What the setting does there
  // is therefore written to, and taken back out of, the environment; reading the same calls
  // through a dispatcher would prove nothing about it.
  if (typeof Bun !== "undefined") {
    assert.equal(process.env.HTTP_PROXY, proxyA, "the saved address reaches the environment Bun reads");
    assert.equal(process.env.HTTPS_PROXY, proxyA);
    setHttpProxy(proxyB);
    assert.equal(process.env.HTTP_PROXY, proxyB, "a new save replaces it in place");
    assert.throws(() => setHttpProxy("socks5:"), /Invalid proxy URL/);
    setHttpProxy(undefined);
    assert.equal(process.env.HTTP_PROXY, undefined, "clearing it leaves nothing the process started without");
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(await (await fetch(originUrl, { signal: AbortSignal.timeout(5_000) })).text(), "ok");
    return;
  }

  const signal = AbortSignal.timeout(5_000);
  const request = async () => assert.equal(await (await fetch(originUrl, { signal })).text(), "ok");
  const reader = (await fetch(`${originUrl}/stream`, { signal })).body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  process.env.HTTPS_PROXY = proxyA;
  setHttpProxy(proxyB);
  assert.throws(() => setHttpProxy("socks5:"), /Invalid proxy URL/);
  await request();
  assert.deepEqual(connectTargets, [["A", originHost], ["B", originHost]]);
  stream.end("last");
  assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
  assert.equal((await reader.read()).done, true);

  process.env.HTTP_PROXY = proxyB;
  process.env.HTTPS_PROXY = proxyA;
  setHttpProxy(originUrl); // Both environment proxies must override this saved address.
  // An http:// origin is tunneled too, exactly as the pi CLI's own dispatcher
  // does it. Forwarding it left the response body on a client that kept
  // undici's own bodyTimeout, so `httpIdleTimeoutMs` never applied.
  await assert.rejects(fetch("http://target.invalid/through-http-proxy", { signal }));
  await assert.rejects(fetch("https://target.invalid/through-https-proxy", { signal }));
  assert.deepEqual(connectTargets.slice(2), [["B", "target.invalid:80"], ["A", "target.invalid:443"]]);
  assert.deepEqual(forwardedRequests, [], "an http origin is tunneled, not forwarded");

  const connectTargetCount = connectTargets.length;
  process.env.NO_PROXY = originHost;
  await request();
  delete process.env.NO_PROXY;
  delete process.env.HTTP_PROXY;
  setHttpProxy(undefined);
  await request();
  assert.equal(connectTargets.length, connectTargetCount);
  assert.deepEqual(forwardedRequests, []);
});

test("recognizes HTTP proxy addresses the dispatcher can use", async () => {
  const jiti = createJiti(import.meta.url);
  const { parseHttpProxy } = await jiti.import("./http-dispatcher.ts");
  for (const value of [undefined, "broken", "http://proxy.example/path", "http://user:%xx@proxy.example", "socks5:"]) {
    assert.equal(parseHttpProxy(value), undefined);
  }
  assert.equal(parseHttpProxy(" https://proxy.example:8080 "), "https://proxy.example:8080");
  for (const url of ["socks5://127.0.0.1:1080", "socks://proxy.example:1080/"]) {
    assert.equal(parseHttpProxy(url), url);
  }
});

test("reads httpIdleTimeoutMs from the agent settings file", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-http-idle-"));
  const settingsPath = join(agentDir, "settings.json");
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  const { readHttpIdleTimeoutMs } = await import("./http-dispatcher.ts");

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
  const { defaultAgentDir } = await import("./http-dispatcher.ts");

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

  for (const value of [undefined, "", "~", "~/agent", "~\\agent", "/abs/agent", "rel/agent", " /padded ", new URL(".", import.meta.url).href, "/c/Users/agent", "/mnt/d/agent"]) {
    if (value === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = value;
    assert.equal(defaultAgentDir(), getAgentDir(), `PI_CODING_AGENT_DIR=${JSON.stringify(value)}`);
  }
});

test("a relocated $HOME moves the agent dir the idle timeout is read from", async (t) => {
  const { defaultAgentDir, readHttpIdleTimeoutMs } = await import("./http-dispatcher.ts");

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
