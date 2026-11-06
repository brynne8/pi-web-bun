import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  fileManagerCommand,
  fileManagerPlatform,
  fileManagerViewFor,
  isFileManagerSupported,
  isLoopbackHost,
  launchFileManager,
  windowsPathForWsl,
  wslDistroName,
} = await jiti.import("./open-in-file-manager.ts");

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

test("reveals one file where the platform can, and its folder where it cannot", () => {
  assert.deepEqual(fileManagerCommand("darwin", "/Users/dev/repo/app.ts", "reveal"), {
    command: "open",
    args: ["-R", "/Users/dev/repo/app.ts"],
  });
  // explorer.exe takes its switch and the path as one argument in its own form.
  assert.deepEqual(fileManagerCommand("win32", "D:/work/repo/app.ts", "reveal"), {
    command: "explorer.exe",
    args: ["/select,D:\\work\\repo\\app.ts"],
  });
  // No Linux file manager has a reveal command, so the folder holding the file
  // opens: still the answer the reader wanted, one step short of selecting it.
  assert.deepEqual(fileManagerCommand("linux", "/home/dev/repo/app.ts", "reveal"), {
    command: "xdg-open",
    args: ["/home/dev/repo"],
  });
  assert.equal(fileManagerCommand("aix", "/home/dev/repo/app.ts", "reveal"), null);
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
  // The distro name is the only sign WSL needs, and it is in every WSL process.
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
  // The distro's own filesystem has no drive letter, so it is reached by its UNC root.
  assert.equal(windowsPathForWsl("/home/dev/repo", "Alpine"), "\\\\wsl.localhost\\Alpine\\home\\dev\\repo");
  assert.equal(windowsPathForWsl("/", "Alpine"), "\\\\wsl.localhost\\Alpine\\");
});

test("a WSL target is asked of explorer.exe in its own path form", () => {
  const env = { WSL_DISTRO_NAME: "Alpine" };
  const kind = fileManagerPlatform("linux", env);
  assert.deepEqual(fileManagerCommand(kind, windowsPathForWsl("/mnt/c/work/repo", "Alpine")), {
    command: "explorer.exe",
    args: ["C:\\work\\repo"],
  });
  assert.deepEqual(fileManagerCommand(kind, windowsPathForWsl("/mnt/c/work/repo/app.ts", "Alpine"), "reveal"), {
    command: "explorer.exe",
    args: ["/select,C:\\work\\repo\\app.ts"],
  });
  assert.deepEqual(fileManagerCommand(kind, windowsPathForWsl("/home/dev/repo/app.ts", "Alpine"), "reveal"), {
    command: "explorer.exe",
    args: ["/select,\\\\wsl.localhost\\Alpine\\home\\dev\\repo\\app.ts"],
  });
});

test("reveals a file and opens a folder, whichever form the caller used", () => {
  const file = { isDirectory: () => false, isFile: () => true };
  const dir = { isDirectory: () => true, isFile: () => false };
  const neither = { isDirectory: () => false, isFile: () => false };
  assert.equal(fileManagerViewFor(true, file), "reveal");
  // A row that is a folder since the listing is opened, not shown in its parent.
  assert.equal(fileManagerViewFor(true, dir), "open");
  assert.equal(fileManagerViewFor(false, dir), "open");
  assert.equal(fileManagerViewFor(false, file), null);
  assert.equal(fileManagerViewFor(true, neither), null);
  assert.equal(fileManagerViewFor(false, neither), null);
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
