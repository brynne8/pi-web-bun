import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

// TEMPORARY: pi's RETRYABLE_PROVIDER_ERROR_PATTERN (pi-ai utils/retry.ts) has covered a relay's
// "Upstream HTTP/2 stream failed" since 1.4.0 (#4433, #3594) but not the same drop worded
// "reset", "closed" or "dropped", so those still end the run. Delete this file and its
// AgentSessionWrapper call once pi's list covers these. This adds cases and widens none:
// an HTTP/2 *stream* and a failure word in one clause, no period or newline between.
const UPSTREAM_HTTP2_STREAM_DROP = /http\/?2[ _-]?stream(?!ing)[^.\n]{0,24}?(?:fail|reset|clos|terminat|abort|cancel|drop|broken|error)/i;

// pi's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN is private: from outside, its fatal
// verdict and "not in the retryable list" are both just false. Re-check the account-limit
// markers here so a relay wrapping a quota/billing body in transport wording stays fatal.
// Only consulted on a path pi already called non-retryable, so it can never suppress a
// retry pi wanted, and drifting from pi's list costs at most today's early fail-fast.
const ACCOUNT_LIMIT_MARKERS = /insufficient_quota|quota exceeded|out of budget|billing|available balance|usage limit|UsageLimitError/i;

interface RetryJudgeHost {
  _isRetryableError?: (this: unknown, message: AssistantMessage) => boolean;
}

export function retryHttp2StreamDrops(session: object): void {
  const host = session as RetryJudgeHost;
  const original = host._isRetryableError;
  // An SDK release that renames the judge leaves this installing a method nothing
  // calls, so the bug comes back on its own instead of breaking session startup.
  // lib/retry-http2-stream-drops.test.mjs pins that name against the installed SDK so
  // it comes back as a red suite, not as a quiet regression.
  if (typeof original !== "function") return;
  host._isRetryableError = function (this: unknown, message: AssistantMessage): boolean {
    // Ask pi first: its verdict is only ever overruled on the way to `true` for a
    // drop, so nothing pi retries can stop being retried.
    if (original.call(this, message)) return true;
    // A user Stop arrives as stopReason "aborted", never "error", so it cannot be
    // retried by wording; context overflow belongs to compaction, not retry.
    return message.stopReason === "error"
      && !!message.errorMessage
      && !isContextOverflow(message)
      && !ACCOUNT_LIMIT_MARKERS.test(message.errorMessage)
      && UPSTREAM_HTTP2_STREAM_DROP.test(message.errorMessage);
  };
}
