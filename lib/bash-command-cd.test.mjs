import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { stripWorkingDirectoryCd } = await jiti.import("./bash-command-cd.ts");

const CWD = "/repo/app";
const strip = (command) => stripWorkingDirectoryCd(command, CWD);

test("a command that cds to where it already runs loses the cd", () => {
  assert.deepEqual(strip("cd /repo/app && make"), { command: "make", stripped: true });
  assert.deepEqual(strip("cd /repo/app; make"), { command: "make", stripped: true });
  assert.deepEqual(strip("  cd /repo/app && make"), { command: "make", stripped: true });
  assert.deepEqual(strip("cd /repo/app &&\n  make"), { command: "make", stripped: true });
  assert.deepEqual(strip("cd /repo/app&&make"), { command: "make", stripped: true });
});

test("only the leading cd to the working directory comes off; the rest of the line stays", () => {
  assert.equal(strip("cd /repo/app && cd src && make").command, "cd src && make");
  assert.equal(strip("cd /repo/app && cd /repo/app && make").command, "make");
});

test("the directory may be quoted or carry a trailing separator", () => {
  assert.equal(strip('cd "/repo/app" && make').command, "make");
  assert.equal(strip("cd '/repo/app' && make").command, "make");
  assert.equal(strip("cd /repo/app/ && make").command, "make");
  assert.equal(stripWorkingDirectoryCd("cd / && ls", "/").command, "ls");
});

test("a cd somewhere else is the call's own work and stays", () => {
  for (const command of ["cd src && make", "cd /repo && make", "cd /repo/appx && make", "git status"]) {
    assert.deepEqual(strip(command), { command, stripped: false });
  }
});

test("a cd that is the whole command stays, since nothing would be left to run", () => {
  for (const command of ["cd /repo/app", "cd /repo/app &&", "cd /repo/app &&   "]) {
    assert.deepEqual(strip(command), { command, stripped: false });
  }
});

test("a windows path matches the case and the separator the model typed", () => {
  const options = { caseInsensitivePaths: true };
  const stripWin = (command) => stripWorkingDirectoryCd(command, "C:\\Users\\me\\app", options);
  assert.equal(stripWin("cd C:\\Users\\me\\app && dir").command, "dir");
  assert.equal(stripWin("cd c:/users/me/app && dir").command, "dir");
  assert.equal(stripWin("cd C:\\Users\\me\\app\\ && dir").command, "dir");
  assert.equal(stripWin("cd C:\\Users\\me\\other && dir").stripped, false);
});

test("a posix path matches its own case and its own separator", () => {
  assert.equal(strip("cd /REPO/app && make").stripped, false);
  assert.equal(stripWorkingDirectoryCd("cd /repo\\app && make", "/repo\\app").command, "make");
});
