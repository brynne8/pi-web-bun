"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");

// vinext is ESM-only, so `require.resolve` cannot see it. Walk up to its CLI
// entry instead: that avoids relying on .bin symlinks (which may not exist
// when installed via npx) and works whether the package is hoisted or nested.
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

module.exports = { findVinextCli };
