// pi-web e2e drives Apple WebKit, never Chromium/Chrome. Import launchBrowser here
// rather than a browser type from "playwright", so the rule stays structural.
//
// Binaries live outside the default registry: ~/Library/Caches/pi-browsers on macOS
// (`npm run test:e2e:install`), Playwright's default path in CI. On macOS that wins
// over an inherited PLAYWRIGHT_BROWSERS_PATH, which on a locked-down machine points at
// a directory nothing may be downloaded into. PI_WEB_BROWSERS overrides it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.platform === "darwin") {
  const dir = process.env.PI_WEB_BROWSERS ?? join(homedir(), "Library", "Caches", "pi-browsers");
  if (existsSync(dir)) process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
}

// Imported after the path above is resolved, so playwright-core reads the right registry.
const { webkit } = await import("playwright");

export async function launchBrowser(options = {}) {
  return webkit.launch(options);
}

// Service workers are blocked on purpose: production registers /sw.js with scope "/", and
// a worker that controls the origin serves app requests without ever reaching
// page.route(). E2E exercises the app, not the PWA shell.
export async function newTestContext(browser, options = {}) {
  return browser.newContext({ ...options, serviceWorkers: "block" });
}
