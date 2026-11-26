import { EventEmitter } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as undici from "undici";
import { homeDir } from "./home-dir.ts";
import { readRegularFileText } from "./regular-file.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

type DispatcherGlobal = typeof globalThis & {
  __piWebHttpDispatcher?: {
    /** Absent under Bun, where no dispatcher serves the fetches. */
    dispatcher?: undici.EnvHttpProxyAgent;
    timeoutMs: number;
    httpProxy?: string;
    httpsProxy?: string;
  };
  /** The proxy variables this process wrote for Bun's fetch, so clearing the setting takes them back out. */
  __piWebHttpProxyEnvironment?: Record<string, string>;
};

const dispatcherGlobal = globalThis as DispatcherGlobal;
const ignoreUndiciDispatcherError = (): void => {};

function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function parseHttpProxy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // Undici's HTTP proxy client takes an origin.
      if (url.pathname !== "/" || url.search || url.hash) return undefined;
    } else if ((url.protocol !== "socks5:" && url.protocol !== "socks:") || !url.hostname) {
      return undefined;
    }
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return value.trim();
  } catch {
    return undefined;
  }
}

/**
 * The agent directory pi keeps its global `settings.json` in, resolved as pi's
 * `getAgentDir()` resolves it. It is resolved here instead of through the SDK
 * because this module runs in Next.js instrumentation: importing the SDK there
 * costs about a second of startup time, while `undici` costs a tenth of one.
 *
 * The one place it does not follow the SDK is the home folder: that comes from
 * `homeDir()`, the app's own rule of `$HOME` first, because Bun's `os.homedir()` —
 * what the SDK calls — ignores `$HOME` and reads the user database. Every other
 * home-based path in pi-web goes through `homeDir()`; reading this one from the
 * runtime would leave the HTTP idle timeout being read from the account's home on a
 * machine that relocated it. Where `$HOME` is the home the user database reports,
 * which is the normal case and the only one Node distinguishes at all, the two agree.
 */
export function defaultAgentDir(): string {
  let configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homeDir(), ".pi", "agent");

  // pi's normalizePath(): Git Bash, MSYS, Cygwin and WSL drive paths on
  // Windows, then `~`, then file: URLs. The value is not trimmed.
  if (process.platform === "win32") configured = windowsShellPath(configured);
  if (configured === "~") return homeDir();
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return join(homeDir(), configured.slice(2));
  }
  if (/^file:\/\//.test(configured)) return fileURLToPath(configured);
  return configured;
}

/** pi's normalizeWindowsShellPath(): `/c/x`, `/mnt/c/x`, `/cygdrive/c/x` to `C:\x`. */
function windowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return path;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

function readSettingsFile(agentDir: string): Record<string, unknown> {
  try {
    const text = readRegularFileText(join(agentDir, "settings.json"));
    if (!text) return {};
    const settings = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return settings && typeof settings === "object" ? settings : {};
  } catch {
    return {};
  }
}

/**
 * The global `httpIdleTimeoutMs`, read the way the pi CLI reads it, so a Web UI
 * session gets the HTTP idle timeout the user configured instead of the
 * built-in default. Only the global file counts: the dispatcher is configured
 * once at startup, before any project is selected, so a project's
 * `.pi/settings.json` cannot apply here.
 *
 * A missing file, a file that does not parse, an absent key, or a value the CLI
 * would reject yields `undefined`, which leaves `configureHttpDispatcher`'s own
 * default in place.
 */
export function readHttpIdleTimeoutMs(agentDir: string = defaultAgentDir()): number | undefined {
  return parseHttpIdleTimeoutMs(readSettingsFile(agentDir).httpIdleTimeoutMs);
}

// Undici can emit an internal Client error while terminating a response body.
// The body stream still rejects; this prevents the EventEmitter error from
// terminating the Next.js process first.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(
    new undici.Client(origin, options as undici.Client.Options),
  );
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const dispatcherOptions = options as undici.Pool.Options;
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions);
  }

  return withUndiciErrorListener(
    new undici.Pool(origin, {
      ...dispatcherOptions,
      factory: createUndiciClient,
    }),
  );
}

export function configureHttpDispatcherFromSettings(agentDir: string = defaultAgentDir()): void {
  const settings = readSettingsFile(agentDir);
  configureHttpDispatcher(
    parseHttpIdleTimeoutMs(settings.httpIdleTimeoutMs),
    parseHttpProxy(settings.httpProxy),
  );
}

export function configureHttpDispatcher(
  timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  proxyUrl?: string,
): void {
  if (dispatcherGlobal.__piWebHttpDispatcher) return;

  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }
  installHttpDispatcher(normalizedTimeoutMs, proxyUrl);
}

/** A replacement dispatcher inherits the timeout chosen at startup. */
export function setHttpProxy(proxyUrl: string | undefined): void {
  const proxy = parseHttpProxy(proxyUrl);
  if (proxy === undefined && proxyUrl?.trim()) throw new Error("Invalid proxy URL");
  const timeoutMs = dispatcherGlobal.__piWebHttpDispatcher?.timeoutMs
    ?? readHttpIdleTimeoutMs()
    ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  installHttpDispatcher(timeoutMs, proxy);
}

function proxyForProtocol(variable: "http_proxy" | "https_proxy", proxyUrl?: string) {
  const upper = variable.toUpperCase();
  const written = dispatcherGlobal.__piWebHttpProxyEnvironment?.[upper];
  // A variable written here carries the saved setting to Bun's fetch, so it reports as the
  // setting and not as an operator's override; the setting's own current value is what applies,
  // including its removal. An address already in the environment stays an override.
  if (written !== undefined && process.env[upper] === written) return { url: proxyUrl, source: "settings" as const };
  const lowerValue = process.env[variable];
  const envValue = lowerValue ?? process.env[upper];
  if (envValue === undefined) return { url: proxyUrl, source: "settings" as const };
  // Windows' environment is case-insensitive; use its conventional uppercase label.
  const source = lowerValue !== undefined && process.platform !== "win32" ? variable : upper;
  return { url: envValue, source };
}

export function resolveHttpProxies(proxyUrl?: string) {
  const http = proxyForProtocol("http_proxy", proxyUrl);
  const https = proxyForProtocol("https_proxy", proxyUrl);
  const httpSource = http.url ? http.source : "direct";
  // EnvHttpProxyAgent falls back to its HTTP agent when the HTTPS URL is empty.
  return {
    httpProxy: http.url,
    httpsProxy: https.url,
    sources: { http: httpSource, https: https.url ? https.source : httpSource },
  };
}

/**
 * Bun's fetch is Bun's own HTTP client: it reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from
 * the environment when a request starts and never consults an undici dispatcher, and the
 * `undici` its module loader hands out exposes no `install` (jiti's CJS interop finds it on
 * Node, Bun's named-export resolution does not). So the setting is applied where Bun looks.
 * A variable the process started with is left alone, which is the precedence Node's
 * `EnvHttpProxyAgent` gives the environment, and one written here is undone with the setting.
 */
function writeProxyEnvironment(httpProxy: string | undefined, httpsProxy: string | undefined): void {
  const written = (dispatcherGlobal.__piWebHttpProxyEnvironment ??= {});
  for (const [variable, value] of [["HTTP_PROXY", httpProxy], ["HTTPS_PROXY", httpsProxy]] as const) {
    if (written[variable] === undefined && process.env[variable] !== undefined) continue;
    if (value === undefined) {
      if (written[variable] !== undefined) {
        delete process.env[variable];
        delete written[variable];
      }
      continue;
    }
    process.env[variable] = value;
    written[variable] = value;
  }
}

function installHttpDispatcher(normalizedTimeoutMs: number, proxyUrl?: string): void {
  const { httpProxy, httpsProxy } = resolveHttpProxies(proxyUrl);
  const previous = dispatcherGlobal.__piWebHttpDispatcher;
  if (previous && previous.httpProxy === httpProxy && previous.httpsProxy === httpsProxy) return;

  if (typeof Bun !== "undefined") {
    writeProxyEnvironment(httpProxy, httpsProxy);
    dispatcherGlobal.__piWebHttpDispatcher = { timeoutMs: normalizedTimeoutMs, httpProxy, httpsProxy };
    return;
  }

  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      allowH2: false,
      // Reach an http:// origin through a CONNECT tunnel, as the pi SDK's own
      // dispatcher does. A forwarded request is carried by a client that keeps
      // undici's own 300 s bodyTimeout, so `httpIdleTimeoutMs` would not apply
      // and a provider stream that stalls cannot be cut at the configured time.
      proxyTunnel: true,
      bodyTimeout: normalizedTimeoutMs,
      // Node's 250 ms default can terminate valid connection attempts on
      // high-latency routes; the pi CLI's dispatcher waits two seconds here.
      connect: { autoSelectFamilyAttemptTimeout: 2_000 },
      headersTimeout: normalizedTimeoutMs,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);

  // `undici.install()` is deliberately not called: it would swap the global
  // fetch/Request/Response classes for undici's own copies, and a server that
  // has already bound the built-in ones rejects the requests the swapped
  // classes create ("Failed to parse URL from [object Request]"). The
  // dispatcher itself needs no install: `setGlobalDispatcher()` writes the
  // well-known symbol Node's built-in fetch reads, so the built-in classes keep
  // serving and use this dispatcher.
  dispatcherGlobal.__piWebHttpDispatcher = { dispatcher, timeoutMs: normalizedTimeoutMs, httpProxy, httpsProxy };

  // close() drains active responses. New fetches already use the new dispatcher.
  previous?.dispatcher?.close().catch((error) => console.warn("Failed to close the previous HTTP dispatcher", error));
}
