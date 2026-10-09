import assert from "node:assert/strict";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findNodeCliScript, nodeCliInvocation } = await jiti.import("./node-cli.ts");

const nodeDir = join("opt", "node", "bin");
const windowsScript = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
const unixScript = join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

// nodeCliInvocation reads the runtime it is running on, so the Node and Bun
// branches each need an explicit process.versions to be asserted.
const onRuntime = (versions, run) => {
  const original = process.versions;
  Object.defineProperty(process, "versions", { value: versions, configurable: true, writable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "versions", { value: original, configurable: true, writable: true });
  }
};
const onNode = (run) => onRuntime({ node: "22.19.0" }, run);

test("both bundled install layouts are probed", () => {
  assert.equal(findNodeCliScript("npm", { nodeDir, fileExists: (p) => p === windowsScript }), windowsScript);
  assert.equal(findNodeCliScript("npm", { nodeDir, fileExists: (p) => p === unixScript }), unixScript);
  assert.equal(findNodeCliScript("npx", { nodeDir, fileExists: () => false }), null);
});

test("the Windows layout wins when both candidates exist", () => {
  assert.equal(findNodeCliScript("npx", { nodeDir, fileExists: () => true }), join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js"));
});

test("npm and npx run through node instead of a .cmd shim", () => {
  const options = { nodeDir, fileExists: (p) => p === windowsScript };
  onNode(() => {
    assert.deepEqual(nodeCliInvocation("npm", ["view", "some-pkg", "version", "--json"], options), {
      command: execPath,
      args: [windowsScript, "view", "some-pkg", "version", "--json"],
    });
  });
});

test("a missing CLI script keeps the bare command and its args", () => {
  onNode(() => {
    assert.deepEqual(
      nodeCliInvocation("npx", ["skills", "find", "pdf"], { nodeDir, fileExists: () => false }),
      { command: "npx", args: ["skills", "find", "pdf"] },
    );
  });
});

test("Bun runs npx through bun x and npm metadata through bun pm view", () => {
  onRuntime({ node: "22.19.0", bun: "1.4.2" }, () => {
    const options = { nodeDir, fileExists: () => true };
    assert.deepEqual(nodeCliInvocation("npx", ["skills", "add", "pdf", "-y", "--agent", "pi"], options), {
      command: execPath,
      args: ["x", "skills", "add", "pdf", "-y", "--agent", "pi"],
    });
    assert.deepEqual(nodeCliInvocation("npm", ["view", "some-pkg", "version", "--json"], options), {
      command: execPath,
      args: ["pm", "view", "some-pkg", "version", "--json"],
    });
  });
});

test("Bun does not translate npm installs, which bun pm cannot do", () => {
  onRuntime({ node: "22.19.0", bun: "1.4.2" }, () => {
    const options = { nodeDir, fileExists: (p) => p === windowsScript };
    assert.deepEqual(nodeCliInvocation("npm", ["install", "some-pkg"], options), {
      command: execPath,
      args: [windowsScript, "install", "some-pkg"],
    });
  });
});