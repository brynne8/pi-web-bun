import assert from "node:assert/strict";
import test from "node:test";
import {
  fileManagerCommand,
  fileManagerPlatform,
  fileManagerRevealCommand,
  isFileManagerSupported,
  isLoopbackHost,
  launchFileManager,
  windowsPathForWsl,
  wslDistroName,
} from "./open-in-file-manager.ts";

test("maps each platform to its file manager command", () => {
  assert.deepEqual(fileManagerCommand("win32", "D:\\work\\repo"), {
    command: "explorer.exe",
    args: ["D:\\work\\repo"],
  });
  assert.deepEqual(fileManagerCommand("darwin", "/Users/dev/repo"), {
    command: "open",
    args: ["/Users/dev/repo"],
  });
  assert.deepEqual(fileManagerCommand("linux", "/home/dev/repo"), {
    command: "xdg-open",
    args: ["/home/dev/repo"],
  });
});

test("reveals an entry selected in its folder, never opening it", () => {
  assert.deepEqual(fileManagerRevealCommand("darwin", "/Users/dev/repo/Tool.app"), {
    command: "open",
    args: ["-R", "/Users/dev/repo/Tool.app"],
  });
  assert.deepEqual(fileManagerRevealCommand("win32", "D:\\work\\my repo\\a.txt"), {
    command: "explorer.exe",
    args: ["/select,", "D:\\work\\my repo\\a.txt"],
  });
  // xdg-open has no selection: the folder that holds it.
  assert.deepEqual(fileManagerRevealCommand("linux", "/home/dev/repo/src/a.ts"), {
    command: "xdg-open",
    args: ["/home/dev/repo/src"],
  });
  assert.equal(fileManagerRevealCommand("aix", "/tmp/a"), null);
});

test("reports platforms without a file manager command", () => {
  assert.equal(isFileManagerSupported("win32"), true);
  assert.equal(isFileManagerSupported("darwin"), true);
  assert.equal(isFileManagerSupported("linux"), true);
  assert.equal(isFileManagerSupported("aix"), false);
  assert.equal(isFileManagerSupported("hasOwnProperty"), false);
  assert.equal(fileManagerCommand("aix", "/tmp"), null);
});

test("names the WSL distro only inside WSL", () => {
  assert.equal(wslDistroName({ WSL_DISTRO_NAME: "Alpine" }), "Alpine");
  assert.equal(wslDistroName({ WSL_DISTRO_NAME: "  Ubuntu  " }), "Ubuntu");
  assert.equal(wslDistroName({ WSL_DISTRO_NAME: "   " }), "");
  assert.equal(wslDistroName({}), "");
});

test("asks the Windows file manager what WSL cannot answer itself", () => {
  assert.equal(fileManagerPlatform("linux", { WSL_DISTRO_NAME: "Alpine" }), "win32");
  assert.equal(fileManagerPlatform("linux", {}), "linux");
  assert.equal(fileManagerPlatform("linux", { WSL_DISTRO_NAME: "  " }), "linux");
  assert.equal(fileManagerPlatform("win32", { WSL_DISTRO_NAME: "Alpine" }), "win32");
  assert.equal(fileManagerPlatform("darwin", { WSL_DISTRO_NAME: "Alpine" }), "darwin");
});

test("puts a WSL path the way Windows names it", () => {
  assert.equal(windowsPathForWsl("/mnt/c/Users/alexa/dev", "Alpine"), "C:\\Users\\alexa\\dev");
  assert.equal(windowsPathForWsl("/mnt/d/data/repo", "Ubuntu"), "D:\\data\\repo");
  assert.equal(windowsPathForWsl("/mnt/c", "Alpine"), "C:\\");
  assert.equal(windowsPathForWsl("/mnt/c/dev/", "Alpine"), "C:\\dev");
  assert.equal(windowsPathForWsl("/home/dev/repo", "Alpine"), "\\\\wsl$\\Alpine\\home\\dev\\repo");
  assert.equal(windowsPathForWsl("/", "Alpine"), "\\\\wsl$\\Alpine\\");
});

test("a WSL target is asked of explorer.exe in its own path form", () => {
  const env = { WSL_DISTRO_NAME: "Alpine" };
  const kind = fileManagerPlatform("linux", env);
  assert.deepEqual(fileManagerCommand(kind, windowsPathForWsl("/mnt/c/work/repo", "Alpine")), {
    command: "explorer.exe",
    args: ["C:\\work\\repo"],
  });
  assert.deepEqual(fileManagerRevealCommand(kind, windowsPathForWsl("/mnt/c/work/repo/app.ts", "Alpine")), {
    command: "explorer.exe",
    args: ["/select,", "C:\\work\\repo\\app.ts"],
  });
  assert.deepEqual(fileManagerRevealCommand(kind, windowsPathForWsl("/home/dev/repo/app.ts", "Alpine")), {
    command: "explorer.exe",
    args: ["/select,", "\\\\wsl$\\Alpine\\home\\dev\\repo\\app.ts"],
  });
});

test("treats loopback host headers as local", () => {
  assert.equal(isLoopbackHost("localhost:30141"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("127.0.0.1:30141"), true);
  assert.equal(isLoopbackHost("127.31.9.2"), true);
  assert.equal(isLoopbackHost("[::1]:30141"), true);
  assert.equal(isLoopbackHost("pi-web.localhost"), true);
});

test("treats LAN, public, and missing hosts as remote", () => {
  assert.equal(isLoopbackHost("192.168.1.20:30141"), false);
  assert.equal(isLoopbackHost("10.0.0.5"), false);
  assert.equal(isLoopbackHost("pi-web.example.com"), false);
  assert.equal(isLoopbackHost("[fe80::1]:30141"), false);
  assert.equal(isLoopbackHost("127.0.0.1.example.com"), false);
  assert.equal(isLoopbackHost(""), false);
  assert.equal(isLoopbackHost(null), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test("refuses to launch on platforms without a file manager", async () => {
  await assert.rejects(launchFileManager("/tmp", "aix"), /Unsupported platform: aix/);
});
