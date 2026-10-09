import type { AssistantMessage } from "@earendil-works/pi-ai";

// TEMPORARY. pi decides whether a failed assistant turn is worth retrying from a
// fixed list of error texts (RETRYABLE_PROVIDER_ERROR_PATTERN in pi-ai's
// utils/retry.ts). Relay providers word a dropped HTTP/2 stream differently from
// the providers those patterns were written against — pi knows Bedrock's "http2
// request did not get a response" but not a relay's "Upstream HTTP/2 stream
// failed" — so the drop fails fast and the run stops. Delete this file and its
// call in AgentSessionWrapper once pi's list covers these messages upstream.
const UPSTREAM_HTTP2_STREAM_DROP = /http\/?2.*stream/i;

interface RetryJudgeHost {
  _isRetryableError?: (this: unknown, message: AssistantMessage) => boolean;
}

export function retryHttp2StreamDrops(session: object): void {
  const host = session as RetryJudgeHost;
  const original = host._isRetryableError;
  // An SDK release that renames the judge leaves this installing a method nothing
  // calls, so the bug comes back on its own instead of breaking session startup.
  if (typeof original !== "function") return;
  host._isRetryableError = function (this: unknown, message: AssistantMessage): boolean {
    if (original.call(this, message)) return true;
    // Falling through to the original verdict first keeps pi's non-retryable
    // quota/billing errors fatal; this only adds texts pi's list misses.
    return message.stopReason === "error" && UPSTREAM_HTTP2_STREAM_DROP.test(message.errorMessage ?? "");
  };
}