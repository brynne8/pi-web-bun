import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { getServerNodeArgs } = require("../bin/pi-web-node-args.cjs");

test("passes the no-wasm-lazy-compilation flag to Node on RISC-V", () => {
  assert.deepEqual(getServerNodeArgs("vinext-bin", ["start", "-p", "30141"], "riscv64"), [
    "--no-wasm-lazy-compilation",
    "vinext-bin",
    "start",
    "-p",
    "30141",
  ]);
});

test("keeps the existing Node arguments on other architectures", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.deepEqual(getServerNodeArgs("vinext-bin", ["start"], arch), ["vinext-bin", "start"]);
  }
});

test("does not mutate the caller's server arguments", () => {
  const serverArgs = ["start", "-H", "127.0.0.1"];

  getServerNodeArgs("vinext-bin", serverArgs, "riscv64");

  assert.deepEqual(serverArgs, ["start", "-H", "127.0.0.1"]);
});
