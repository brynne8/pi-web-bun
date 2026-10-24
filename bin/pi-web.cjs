#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version.cjs");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getServerNodeArgs } = require("./pi-web-node-args.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripPrerenderSecret, getStripWarning } = require("./vinext-secrets.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openInBrowser } = require("./browser-opener.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir, isServerAnswering } = require("./run-records.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands.cjs");

const READY_POLL_MS = 200;

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions);
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

function findVinextCli(pkgDir) {
  let dir = pkgDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", "vinext", "dist", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function startServer({ port, hostname, openBrowser }) {
  const pkgDir = path.join(__dirname, "..");
  const distDir = path.join(pkgDir, "dist");

  // vinext is ESM-only, so `require.resolve` cannot see it. Walk up to its CLI
  // entry instead: that avoids relying on .bin symlinks (which may not exist
  // when installed via npx) and works whether the package is hoisted or nested.
  const vinextBin = findVinextCli(pkgDir);
  if (!vinextBin) {
    console.error("Could not find vinext. Please report this issue.");
    process.exit(1);
  }

  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

  if (!fs.existsSync(path.join(distDir, "server", "index.js"))) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // vinext writes its prerender secret into the build output, which the npm
  // tarball would publish. Remove it before the server reads the manifest.
  const strip = stripPrerenderSecret(distDir);
  if (!strip.ok) {
    console.warn(getStripWarning(strip.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  // Always run vinext's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, getServerNodeArgs(vinextBin, ["start", "-p", port, "-H", hostname]), {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname },
  });
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      serverPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));

  // `vinext start` has no "Ready" line, so readiness is the server answering.
  // A browser on this machine reaches a wildcard bind through loopback.
  if (port !== "0") {
    const url = getOpenUrl(hostname, port);
    let serverReady = false;
    const readyTimer = setInterval(async () => {
      if (serverReady || child.exitCode !== null) return;
      if (!(await isServerAnswering(url))) return;
      serverReady = true;
      clearInterval(readyTimer);
      runRecord.markReady();
      if (openBrowser) openInBrowser(url);
    }, READY_POLL_MS);
    readyTimer.unref();
    child.once("exit", () => clearInterval(readyTimer));
  }
}
