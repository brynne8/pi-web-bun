import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { platformSection, createPlatformInfoExtension } = await jiti.import("./platform-info.ts");

test("the platform section names the OS, its arch and kernel, and the terminal shell", () => {
  assert.equal(
    platformSection({ platform: "darwin", arch: "arm64", kernel: "27.2.0", shell: "/bin/zsh" }),
    ["- OS: macOS (darwin, arm64, kernel 27.2.0)", "- Interactive terminal shell: zsh (/bin/zsh)"].join("\n"),
  );
  assert.equal(
    platformSection({ platform: "linux", arch: "x64", kernel: "6.8.0", shell: "/bin/bash" }),
    ["- OS: Linux (linux, x64, kernel 6.8.0)", "- Interactive terminal shell: bash (/bin/bash)"].join("\n"),
  );
  // A machine that answers no $SHELL gets no shell line rather than a guess.
  assert.equal(
    platformSection({ platform: "win32", arch: "x64", kernel: "10.0.26100", shell: "" }),
    "- OS: Windows (win32, x64, kernel 10.0.26100)",
  );
  // A platform the map does not name is reported as itself.
  assert.match(platformSection({ platform: "sunos", arch: "x64", kernel: "5.11", shell: "/bin/sh" }), /^- OS: sunos \(sunos, x64, kernel 5\.11\)/);
});

test("the extension sets the section on every turn and touches nothing else", () => {
  let handler;
  const pi = { on: (event, fn) => { if (event === "before_agent_start") handler = fn; } };
  createPlatformInfoExtension().factory(pi);
  const event = { systemPromptOptions: { sections: {} } };
  handler(event);
  const sections = event.systemPromptOptions.sections;
  assert.deepEqual(Object.keys(sections), ["platform"]);
  assert.match(sections.platform, /^- OS: .+\(.+, kernel .+\)/);
  // This machine's own answer, whatever runner is reading it: a shell line only with a $SHELL.
  if (process.env.SHELL) assert.match(sections.platform, /\n- Interactive terminal shell: .+ \(.+\)$/);
});
