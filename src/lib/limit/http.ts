import { NextResponse } from "next/server";

import { retryAfterSeconds } from "./policy";

/**
 * A 429 with a truthful `Retry-After` (#18).
 *
 * The header is the machine-readable half and the body is the human half; both
 * are required by the issue, and neither substitutes for the other. A client
 * that retries on a schedule reads the header, and a person reads the message —
 * which is the product's own copy, not a status code shown to someone who did
 * nothing wrong.
 *
 * `Retry-After` is exact rather than a fixed backoff because the limiter knows
 * precisely when the bucket lets the next request through. A padded guess would
 * be the polite kind of lie: it makes the limit stricter than it was configured
 * to be, and only for the callers honest enough to obey the header.
 */
export function tooManyRequests(message: string, retryAfterMs: number): NextResponse {
  const seconds = retryAfterSeconds(retryAfterMs);
  return NextResponse.json(
    { error: "rate_limited", message, retryAfterSeconds: seconds },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}
