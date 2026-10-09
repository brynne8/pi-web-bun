import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { retryHttp2StreamDrops } = await jiti.import("./retry-http2-stream-drops.ts");

function judge() {
  const session = { _isRetryableError: isRetryableAssistantError };
  retryHttp2StreamDrops(session);
  return (errorMessage, stopReason = "error") => session._isRetryableError({ errorMessage, stopReason });
}

test("a relay's HTTP/2 stream drop is retried, though pi's own list misses it", () => {
  const isRetryable = judge();

  assert.equal(isRetryableAssistantError({ stopReason: "error", errorMessage: "Upstream HTTP/2 stream failed" }), false);
  assert.equal(isRetryable("Upstream HTTP/2 stream failed"), true);
  assert.equal(isRetryable("upstream_http2_stream_error: Upstream HTTP/2 stream failed"), true);
});

test("the patch only adds texts: pi's verdicts still decide everything else", () => {
  const isRetryable = judge();

  assert.equal(isRetryable("OpenAI Responses stream ended before a terminal response event"), true);
  assert.equal(isRetryable("server_error: Our servers are currently overloaded."), true);
  assert.equal(isRetryable("insufficient_quota: You exceeded your current quota"), false);
  assert.equal(isRetryable("Monthly usage limit reached"), false);
  assert.equal(isRetryable("some error we have never seen"), false);
  assert.equal(isRetryable(undefined), false);
  // An aborted turn carrying the same wording is the user's Stop, not a drop.
  assert.equal(isRetryable("Upstream HTTP/2 stream failed", "aborted"), false);
});

test("a session whose judge is gone is left alone instead of crashing a run", () => {
  const session = {};
  retryHttp2StreamDrops(session);
  assert.equal("_isRetryableError" in session, false);
});