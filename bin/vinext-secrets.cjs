"use strict";

// vinext's build writes its prerender secret to `dist/server/vinext-server.json`.
// The production server reads it from there to authenticate internal
// `/__vinext/prerender/*` requests and the route-params side channel. A published
// tarball would ship that value, so it is removed before the server starts:
// without a secret those routes answer 403 and the side channel is ignored.
//
// The on-demand revalidation secret is baked into the server bundle by vinext
// instead of living in a file. `vite.config.mts` keeps that one out of the build,
// so the runtime generates a fresh value per process.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");

const SERVER_MANIFEST = "vinext-server.json";

/**
 * Remove the prerender secret from the built server manifest. Never throws:
 * returns a status the caller can surface, because an install that cannot be
 * rewritten keeps a published secret.
 *
 * @param {string} distDir absolute path to the package's `dist` directory
 * @returns {{ ok: boolean, reason?: string, error?: Error }}
 */
function stripPrerenderSecret(distDir) {
  const manifestPath = path.join(distDir, "server", SERVER_MANIFEST);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    // No manifest means no secret to leak.
    if (error && error.code === "ENOENT") return { ok: true, reason: "missing" };
    return { ok: false, reason: "unreadable", error };
  }

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "unexpected-shape" };
  }
  if (!Object.hasOwn(manifest, "prerenderSecret")) {
    return { ok: true, reason: "already-stripped" };
  }

  delete manifest.prerenderSecret;

  // Write to a sibling temp file and rename so a concurrent server start never
  // reads a half-written manifest.
  const tempPath = path.join(path.dirname(manifestPath), `${SERVER_MANIFEST}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(manifest));
    fs.renameSync(tempPath, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort: leaving a stray temp file is harmless.
    }
    return { ok: false, reason: "unwritable", error };
  }

  return { ok: true, reason: "stripped" };
}

function getStripWarning(reason) {
  const detail =
    reason === "unwritable"
      ? "the install directory is not writable"
      : reason === "unreadable"
        ? "its server manifest could not be read"
        : "its server manifest has an unexpected format";
  return [
    `Warning: could not clear pi-web's prerender secret because ${detail}.`,
    "This instance keeps the published secret, so a client that knows it can",
    "authenticate the internal /__vinext/prerender routes. Run from a writable",
    "install, or restrict network access to this instance.",
  ].join("\n");
}

module.exports = {
  SERVER_MANIFEST,
  getStripWarning,
  stripPrerenderSecret,
};
