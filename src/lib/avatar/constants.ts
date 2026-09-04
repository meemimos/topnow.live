/**
 * Limits for avatar resolution (#19).
 *
 * Every number here is a bound on something a stranger can influence. They live
 * together so the whole budget of a hostile fetch — bytes, seconds, hops — can
 * be read at once rather than reconstructed from call sites.
 */

/** The rendered sizes, in CSS pixels: 78px for slot 01, 38px for 02 and 03. */
export const AVATAR_SIZES = { large: 78, small: 38 } as const;

export type AvatarSize = keyof typeof AVATAR_SIZES;

/**
 * Stored at twice the rendered size, for the same reason any image is: a 78px
 * box on a 2x display shows a 156px image. Anything beyond 2x is bytes nobody
 * can see.
 */
export const AVATAR_SCALE = 2;

export function storedPixels(size: AvatarSize): number {
  return AVATAR_SIZES[size] * AVATAR_SCALE;
}

/**
 * Hard cap on what will be read from an upstream response.
 *
 * Enforced while streaming, not from `Content-Length` — a hostile server can
 * declare one byte and send forever, and a decompression bomb declares less
 * still.
 */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Anything slower than this is treated as a failure.
 *
 * Short deliberately. This runs on the payment path (#26) and later behind the
 * hourly job (#22); a resolver that waits thirty seconds for a dead host turns
 * one broken platform into a queue of stuck requests.
 */
export const FETCH_TIMEOUT_MS = 4_000;

/** Redirect hops allowed. Each one is re-checked against the allow-list. */
export const MAX_REDIRECTS = 3;

/** What the store re-encodes to. One format out, whatever went in. */
export const STORED_CONTENT_TYPE = "image/webp";

/** A resolved avatar is refreshed after this long — on a schedule, never on read. */
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * A failure is cached too, and retried far less often than a success is
 * refreshed. Without this, every unresolvable handle becomes a permanent
 * outbound request on every refresh cycle — the rate-limit budget #18 is about.
 */
export const RETRY_FAILED_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Wall-clock a single refresh pass may spend.
 *
 * A count limit alone does not bound the time — twenty rows each timing out at
 * four seconds is eighty seconds inside one scheduled request, which is past
 * the limit of most serverless runtimes. Whatever is not reached stays stale
 * and is picked up next tick, oldest first.
 */
export const REFRESH_BUDGET_MS = 20_000;
