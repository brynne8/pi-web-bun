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

// What counts as browser noise this harness causes, rather than an app error to fail on.
// One predicate for the whole suite, because each module keeps and asserts its OWN list of
// errors (`e2e/session-navigation.mjs`, `e2e/pdf-page-fragment.mjs`, `e2e/terminal.mjs`,
// `e2e/themes.mjs`, and run.mjs's for the main page): a pattern added to one collector leaves
// the next module to fail on the same line, and on a browser the developer does not have —
// which is exactly how the viewport-meta entry below reached CI after being "fixed".
const IGNORED_BROWSER_ERRORS = [
  /Service Worker is disabled because the context is sandboxed/, // serviceWorkers: "block" above
  /ResizeObserver loop completed with undelivered notifications/,
  // A read this page fired that the next document's navigation cancelled, named by whichever
  // hook wanted it: hooks/useAgentSession.ts's context, tools, agent state and slash-command
  // reads, and components/AppShell.tsx's panel loads. loadContext keeps quiet when its own
  // signal says so; the others have no signal to consult and log the rejection either way, so
  // one event arrives under several names. Keeping the quiet side of a load out of the app
  // needs a signal on that path, and nothing here can watch a teardown it never sees, so the
  // sentence is the pin and the label is not.
  /^Failed to load [^:]+: TypeError: Load failed$/,
  // The viewport meta carries `interactive-widget=resizes-content` on purpose (app/layout.tsx:
  // the Chromium-only virtual-keyboard key an Android reader needs). WebKit on the Linux CI
  // image reads the meta and prints this at error level, once per parse; the macOS WebKit
  // build reads the same tag and says nothing at any level, so no local run ever sees it.
  // Nothing is broken either way, so the pattern stays pinned to this one key and sentence.
  /^Viewport argument key "interactive-widget" not recognized and ignored\.$/,
  // The app's reads are relative fetches, several with an AbortController of their own
  // (components/SessionSidebar.tsx's running-state poll; hooks/useAgentSession.ts's context,
  // tools, per-session state and lease reads), and the client builds no absolute URL anywhere,
  // so the only document WebKit can deny one to is a page whose own origin has already gone: a
  // read still in flight while the page navigates. Pinned to this harness's own origin
  // (`127.0.0.1`, e2e/run.mjs), to the app's `/api` route family and to this sentence — a call
  // to another host, or any other message, is a bug worth failing on. The family is the whole
  // prefix on purpose: the per-session state read reached this the way the agent routes did,
  // and naming the agent routes alone let it through.
  /\b127\.0\.0\.1:\d+\/api\/\S+ due to access control checks\.$/,
];

/** Whether a pageerror or console-error text is this harness's own noise, not the app's. */
export function isIgnorableBrowserError(text) {
  return IGNORED_BROWSER_ERRORS.some((pattern) => pattern.test(text));
}

/** Records an error unless it is the harness's own noise: the one gate every collector pushes through. */
export function noteBrowserError(errors, text) {
  if (!isIgnorableBrowserError(text)) errors.push(text);
}
