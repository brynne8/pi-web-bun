import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { libcOf, platformSection, wslOf, createPlatformInfoExtension } = await jiti.import("./platform-info.ts");

const ALPINE_RELEASE = [
  'NAME="Alpine Linux"',
  "ID=alpine",
  'VERSION_ID=3.21',
  'PRETTY_NAME="Alpine Linux v3.21"',
  "HOME_URL=https://alpinelinux.org/",
].join("\n");

const UBUNTU_RELEASE = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  "NAME=Ubuntu",
  "ID=ubuntu",
  'VERSION_ID="24.04"',
].join("\n");

test("the OS line names the distribution, its libc and WSL, which the platform token does not", () => {
  // The reported box: Alpine on WSL2, whose /bin/sh is busybox rather than bash.
  assert.equal(
    platformSection({
      platform: "linux", arch: "x64", kernel: "6.18.58.1-microsoft-standard-WSL2",
      shell: "/bin/sh", shellLink: "/bin/busybox", muslLoader: true, osRelease: ALPINE_RELEASE,
    }),
    [
      "- OS: Alpine Linux v3.21 (linux, x64, musl, WSL2)",
      "- Interactive terminal shell: sh (/bin/sh → busybox)",
    ].join("\n"),
  );
  // A glibc distro keeps the kernel number the WSL string would otherwise replace.
  assert.equal(
    platformSection({
      platform: "linux", arch: "x64", kernel: "6.8.0-51-generic",
      shell: "/bin/bash", osRelease: UBUNTU_RELEASE,
    }),
    [
      "- OS: Ubuntu 24.04.1 LTS (linux, x64, glibc, kernel 6.8.0-51-generic)",
      "- Interactive terminal shell: bash (/bin/bash)",
    ].join("\n"),
  );
  // No os-release: the line stays what the platform token alone can say.
  assert.equal(
    platformSection({ platform: "linux", arch: "x64", kernel: "6.8.0-51-generic", shell: "" }),
    "- OS: Linux (linux, x64, glibc, kernel 6.8.0-51-generic)",
  );
});

test("a shell line says where $SHELL points only when it is a symlink", () => {
  const query = { platform: "linux", arch: "x64", kernel: "6.8.0", osRelease: UBUNTU_RELEASE };
  // Ubuntu's /bin/sh is dash: one hop says ash is not bash.
  assert.match(
    platformSection({ ...query, shell: "/bin/sh", shellLink: "/usr/bin/dash" }),
    /\n- Interactive terminal shell: sh \(\/bin\/sh → dash\)$/,
  );
  // A real file, not a symlink: the path alone.
  assert.match(
    platformSection({ ...query, shell: "/bin/bash" }),
    /\n- Interactive terminal shell: bash \(\/bin\/bash\)$/,
  );
  // No $SHELL at all (Windows): no line rather than a guess.
  assert.ok(!platformSection({ platform: "win32", arch: "x64", kernel: "10.0.26100", shell: "" }).includes("terminal shell"));
});

test("the libc is musl from the loader or the os-release, glibc otherwise", () => {
  assert.equal(libcOf({ muslLoader: true, osRelease: UBUNTU_RELEASE }), "musl");
  assert.equal(libcOf({ osRelease: ALPINE_RELEASE }), "musl", "Alpine is musl even without the loader seen");
  assert.equal(libcOf({ osRelease: UBUNTU_RELEASE }), "glibc");
  assert.equal(libcOf({}), "glibc");
});

test("a WSL kernel says so, and WSL2 more precisely than the raw string", () => {
  assert.equal(wslOf("6.18.58.1-microsoft-standard-WSL2"), "WSL2");
  assert.equal(wslOf("4.4.0-19041-Microsoft"), "WSL");
  assert.equal(wslOf("6.8.0-51-generic"), undefined);
  assert.equal(wslOf(undefined), undefined);
});

test("macOS and Windows keep the line they had", () => {
  assert.equal(
    platformSection({ platform: "darwin", arch: "arm64", kernel: "27.2.0", shell: "/bin/zsh" }),
    [
      "- OS: macOS (darwin, arm64, kernel 27.2.0)",
      "- Interactive terminal shell: zsh (/bin/zsh)",
    ].join("\n"),
  );
  assert.equal(
    platformSection({ platform: "win32", arch: "x64", kernel: "10.0.26100", shell: "" }),
    "- OS: Windows (win32, x64, kernel 10.0.26100)",
  );
});

test("the extension sets the section on every turn and touches nothing else", () => {
  let handler;
  const pi = { on: (event, fn) => { if (event === "before_agent_start") handler = fn; } };
  createPlatformInfoExtension().factory(pi);
  const event = { systemPromptOptions: { sections: {} } };
  handler(event);
  const sections = event.systemPromptOptions.sections;
  assert.deepEqual(Object.keys(sections), ["platform"]);
  assert.match(sections.platform, /^- OS: .+\(.+, .+\)/);
  // This machine's own answer, whatever runner is reading it: a shell line only with a $SHELL.
  if (process.env.SHELL) assert.match(sections.platform, /\n- Interactive terminal shell: .+ \(.+\)$/);
});
