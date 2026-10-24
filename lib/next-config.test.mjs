import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../next-config.ts", import.meta.url);
const { nextConfig } = await import(configUrl.href);
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("stamps the app version into the client bundle", () => {
  assert.equal(nextConfig.env.NEXT_PUBLIC_APP_VERSION, version);
});

test("leaves the image optimizer off", () => {
  assert.equal(nextConfig.images.unoptimized, true);
});

test("keeps native modules out of the server bundle", () => {
  assert.ok(nextConfig.serverExternalPackages.includes("node-pty"));
});
