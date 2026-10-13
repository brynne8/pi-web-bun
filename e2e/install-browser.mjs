// Downloads the WebKit build that pi-web's e2e tests drive. Never Chromium.
// Mirrors the path policy in e2e/browser.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "playwright", "cli.js");
if (!existsSync(cli)) {
  console.error("playwright is not installed; run `bun install` first.");
  process.exit(1);
}

const env = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "0" };
if (process.platform === "darwin") {
  const dir = process.env.PI_WEB_BROWSERS ?? join(homedir(), "Library", "Caches", "pi-browsers");
  mkdirSync(dir, { recursive: true });
  env.PLAYWRIGHT_BROWSERS_PATH = dir;
  console.log(`installing webkit into ${dir}`);
}

execFileSync(process.execPath, [cli, "install", "webkit"], { stdio: "inherit", env });
process.exit(0);
