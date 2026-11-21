/**
 * Waiting in tests without a wall clock.
 *
 * A test that sleeps a fixed number of milliseconds and then asserts is guessing: too short and it
 * fails on a loaded machine, too long and it costs every run. These two helpers say what the test
 * is actually waiting for — a state, or the queued work a call just started.
 */

/**
 * Runs until `condition` holds, one macrotask at a time. Throws the message rather than hanging
 * when the condition never comes.
 */
export async function waitFor(condition, what = "condition", timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Lets the work a call may have queued run, without any wall clock: a few macrotasks are what a
 * promise chain — a lock, a debounce that already fired, a sync — needs to reach its first real
 * await, so an assertion that nothing has happened yet has a point to be measured from.
 */
export async function settle(turns = 3) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
