import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The hook runs against a stand-in for React's hooks, mocked timers and a fake
// AudioContext whose resume() settles when the test says so, so the context's
// lifecycle between chimes can be played out without a browser.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
// tryNative: false — Bun imports a .ts file natively and answers its `react` import
// from node_modules, so jiti's alias to the hook shim would never apply. Bun runs the
// whole suite in one process with one module registry, so a file that ran earlier may
// already have loaded the hook natively, with the real React; drop that copy so this
// file gets its own. Under Node each file has its own process.
const nodeRequire = createRequire(import.meta.url);
delete nodeRequire.cache[realpathSync(fileURLToPath(new URL("./useAudio.ts", import.meta.url)))];
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, tryNative: false, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { AUDIO_IDLE_SUSPEND_MS, useAudio } = await jiti.import("./useAudio.ts");

const node = () => ({ connect() {}, start() {}, stop() {}, frequency: {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } });

let contexts = [];
class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.currentTime = 0;
    this.destination = {};
    this.calls = [];
    this.resumes = [];
    this.tones = 0;
    contexts.push(this);
  }
  resume() {
    this.calls.push("resume");
    return new Promise((resolve, reject) => {
      this.resumes.push({
        resolve: () => { this.state = "running"; resolve(); },
        reject: () => reject(new DOMException("interrupted", "InvalidStateError")),
      });
    });
  }
  suspend() {
    this.calls.push("suspend");
    this.state = "suspended";
    return Promise.resolve();
  }
  close() {
    this.calls.push("close");
    this.state = "closed";
    return Promise.resolve();
  }
  createOscillator() { this.tones++; return node(); }
  createGain() { return node(); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
// Settle every outstanding resume() of the context, then let its callbacks run.
async function resolveResumes(ctx) {
  for (const pending of ctx.resumes.splice(0)) pending.resolve();
  await flush();
}

const stored = new Map();
test.beforeEach(() => {
  contexts = [];
  stored.clear();
  globalThis.window = {};
  globalThis.localStorage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  globalThis.AudioContext = FakeAudioContext;
  mock.timers.enable({ apis: ["setTimeout"] });
});

test.afterEach(() => {
  mock.timers.reset();
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.AudioContext;
});

test("a chime resumes the context, plays, and suspends it once the chime is over", async () => {
  const view = renderHook(() => useAudio());
  view.result.playDoneSound();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 2, "both tones were scheduled");
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS - 1);
  assert.deepEqual(ctx.calls, ["resume"], "still running while the chime plays");
  mock.timers.tick(1);
  assert.deepEqual(ctx.calls, ["resume", "suspend"]);
  assert.equal(ctx.state, "suspended");

  view.result.playDoneSound();
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 4, "the next chime resumes the same context");
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "suspend", "resume", "suspend"]);
  assert.equal(contexts.length, 1, "never a new context");
});

test("a newer chime pushes the suspend back instead of cutting itself off", async () => {
  const view = renderHook(() => useAudio());
  view.result.playDoneSound();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  mock.timers.tick(600);
  view.result.playDoneSound();
  await resolveResumes(ctx);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS - 1);
  assert.ok(!ctx.calls.includes("suspend"), "the first chime's timer did not fire");
  mock.timers.tick(1);
  assert.deepEqual(ctx.calls, ["resume", "resume", "suspend"], "one suspend after the last chime");
});

test("an outstanding resume holds off the idle suspend until it settles", async () => {
  const view = renderHook(() => useAudio());
  view.result.playDoneSound();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  mock.timers.tick(900);
  view.result.playDoneSound();
  mock.timers.tick(200);
  assert.ok(!ctx.calls.includes("suspend"), "the second chime is still resuming");
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 4);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "resume", "suspend"]);
});

test("an unlock resumes a suspended context from the gesture, then suspends it again", async () => {
  const view = renderHook(() => useAudio());
  view.result.unlockAudio();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 0, "an unlock plays nothing");
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "suspend"], "an unlock does not leave the context running");

  view.result.unlockAudio();
  assert.deepEqual(ctx.calls, ["resume", "suspend", "resume"], "every send's gesture resumes a suspended context");
  await resolveResumes(ctx);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.equal(ctx.calls.at(-1), "suspend");
});

test("an unlock while the context runs does nothing", async () => {
  const view = renderHook(() => useAudio());
  view.result.playDoneSound();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  view.result.unlockAudio();
  view.result.unlockAudio(true);
  assert.deepEqual(ctx.calls, ["resume"]);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "suspend"], "nor does it delay the chime's suspend");
});

test("a chime after an earlier unlock resumes the context without a gesture", async () => {
  const view = renderHook(() => useAudio());
  view.result.unlockAudio();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.equal(ctx.state, "suspended");

  view.result.playDoneSound();
  assert.deepEqual(ctx.calls, ["resume", "suspend", "resume"]);
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 2);
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "suspend", "resume", "suspend"]);
});

test("a rejected resume plays nothing, still suspends, and the next gesture tries again", async () => {
  const view = renderHook(() => useAudio());
  view.result.unlockAudio();
  const [ctx] = contexts;
  ctx.resumes.splice(0).forEach((pending) => pending.reject());
  await flush();
  mock.timers.tick(AUDIO_IDLE_SUSPEND_MS);
  assert.deepEqual(ctx.calls, ["resume", "suspend"]);

  view.result.unlockAudio();
  assert.deepEqual(ctx.calls, ["resume", "suspend", "resume"]);

  view.result.playDoneSound();
  ctx.resumes.splice(0).forEach((pending) => pending.reject());
  await flush();
  assert.equal(ctx.tones, 0);
});

test("turning sound off suspends at once and drops a chime still resuming", async () => {
  const view = renderHook(() => useAudio());
  view.result.unlockAudio();
  const [ctx] = contexts;
  await resolveResumes(ctx);
  view.result.playDoneSound();
  view.result.onSoundToggle();
  view.flush();
  assert.equal(view.result.soundEnabled, false);
  assert.equal(ctx.calls.at(-1), "suspend", "suspended without waiting for the timer");
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 0, "the resumed chime saw the sound turned off");

  view.result.playDoneSound();
  view.result.unlockAudio();
  assert.equal(ctx.resumes.length, 0, "nothing resumes while sound is off");
  assert.ok(!ctx.calls.includes("close"), "the context is never closed");
  assert.equal(stored.get("pi-sound-enabled"), "false");

  view.result.onSoundToggle();
  view.flush();
  view.result.playDoneSound();
  await resolveResumes(ctx);
  assert.equal(ctx.tones, 2, "back on, the same context plays");
});
