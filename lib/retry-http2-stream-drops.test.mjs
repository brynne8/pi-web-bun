import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { retryHttp2StreamDrops } = await jiti.import("./retry-http2-stream-drops.ts");

// tryNative: false — under Bun jiti defaults to a native import, which answers the
// module's own imports itself and never applies an alias (docs/agents/tests.md).
// rpc-manager.ts pulls the whole SDK graph, so pin the resolution for both runners.
const rpcJiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  tryNative: false,
});
const { AgentSessionWrapper } = await rpcJiti.import("./rpc-manager.ts");

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
  assert.equal(isRetryable("HTTP/2 stream was reset (INTERNAL_ERROR)"), true);
  assert.equal(isRetryable("HTTP/2 stream closed before the response completed"), true);
  assert.equal(isRetryable("relay: http/2 stream dropped while streaming tools"), true);
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

test("an HTTP/2 mention that is not a stream drop stays fatal", () => {
  const isRetryable = judge();

  // Every one of these is fatal to pi too, so a looser predicate is what would make
  // them retry: an abort, a framing/protocol failure, a config or policy refusal, and
  // a transport phrase attached to a fatal quota/overflow verdict.
  const notAStreamDrop = [
    "HTTP/2 stream",
    "AbortError: The operation was aborted.",
    "The user aborted a request.",
    "ERR_HTTP2_PAYLOAD_ERROR: Invalid payload length 16777216 greater than maximum 16384",
    "PROTOCOL_ERROR: http/2 connection negotiated h2 but streams were refused",
    "model http2-large does not support streaming",
    "your proxy says http/2 streams are blocked by policy",
    "insufficient_quota: quota exhausted (HTTP/2 stream reset upstream)",
    "Monthly usage limit reached (HTTP/2 stream closed)",
    "billing overdue (http/2 stream failure while sending)",
    "prompt too long: http/2 stream failed while sending 300k tokens",
  ];
  for (const errorMessage of notAStreamDrop) {
    assert.equal(isRetryableAssistantError({ errorMessage, stopReason: "error" }), false, errorMessage);
    assert.equal(isRetryable(errorMessage), false, errorMessage);
  }
});

test("a session whose judge is gone is left alone instead of crashing a run", () => {
  const session = {};
  retryHttp2StreamDrops(session);
  assert.equal("_isRetryableError" in session, false);
});

// ---------------------------------------------------------------------------
// The pin.
//
// Upstream declined this fix because it hangs on a private method of pi's session
// class; this fork carries it anyway, which makes the private name our risk to
// watch. `retryHttp2StreamDrops()` installs nothing when the method is not there —
// by design, so a rename cannot break session startup — and that is exactly the
// silent failure these two tests exist to prevent: the dropped-stream bug would
// come back with a green suite and no other symptom.

/** The least an `AgentSessionLike` has to be for the constructor to take it. */
function makeInner(overrides = {}) {
  return {
    sessionId: "http2-retry-pin",
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    agent: { state: {} },
    subscribe: () => () => {},
    dispose() {},
    ...overrides,
  };
}

test("AgentSessionWrapper's constructor installs the shim on the inner session", () => {
  // The inner is the object pi calls, so the wrap has to land on it: a constructor
  // that stopped calling the shim, or called it on the wrapper instead, fixes nothing.
  const inner = makeInner({ _isRetryableError: isRetryableAssistantError });
  const piJudge = inner._isRetryableError;

  const wrapper = new AgentSessionWrapper(inner);

  assert.equal(wrapper.inner, inner);
  assert.notEqual(inner._isRetryableError, piJudge, "the constructor wrapped nothing");

  const dropped = { role: "assistant", stopReason: "error", errorMessage: "Upstream HTTP/2 stream failed" };
  assert.equal(isRetryableAssistantError(dropped), false, "pi alone still misses this wording");
  assert.equal(inner._isRetryableError(dropped), true, "the inner session retries a dropped stream");
  // pi's verdicts pass through the wrap untouched.
  assert.equal(inner._isRetryableError({ stopReason: "error", errorMessage: "server_error: overloaded" }), true);
  assert.equal(inner._isRetryableError({ stopReason: "error", errorMessage: "some error we have never seen" }), false);
  assert.equal(inner._isRetryableError({ stopReason: "aborted", errorMessage: "Upstream HTTP/2 stream failed" }), false);
});

test("pi's session class still names and calls its own retry judge", () => {
  // The two greps are how this repo pins SDK internals (see lib/project-trust.test.mjs):
  // the same source the running class comes from, read as text.
  const sdkDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const sourcePath = join(sdkDist, "core", "agent-session.js");
  assert.ok(existsSync(sourcePath), `${sourcePath} is gone: re-derive where AgentSession lives`);
  const source = readFileSync(sourcePath, "utf8");

  // The method the wrap replaces, still defined as a method taking one message.
  assert.ok(
    /^\s*_isRetryableError\(message\) \{$/m.test(source),
    "pi's AgentSession no longer defines _isRetryableError(message) — re-derive it in "
    + "lib/retry-http2-stream-drops.ts (and its call in AgentSessionWrapper's constructor), "
    + "or delete both if pi now retries a relay's HTTP/2 stream drop on its own",
  );
  // Called through `this`, both times: the `willRetry` hint on agent_end and the retry
  // decision. A judge pi calls as a plain function instead would never consult the
  // own property the shim sets, so the fix would be dead while still installing.
  const callSites = source.match(/this\._isRetryableError\(/g) ?? [];
  assert.ok(
    callSites.length >= 2,
    "pi's AgentSession reaches its own judge through `this` only " + callSites.length
    + " time(s); the wrap needs the one funnel that both agent_end's willRetry hint and the"
    + " retry decision call,",
  );

  // And the grepped file is the class that runs: the package entry's `AgentSession`,
  // not a copy left behind next to a bundle.
  assert.equal(typeof AgentSession.prototype._isRetryableError, "function");
});
