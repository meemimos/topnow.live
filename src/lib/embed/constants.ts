/**
 * Limits for embed resolution (#20).
 *
 * Tighter than the avatar's in every dimension that matters, because this runs
 * on the same submit path and adds a second third party to it. A slow embed is a
 * failed embed — the issue says so, and the number below is what makes that true
 * rather than aspirational.
 */

/** The provider has this long to answer. */
export const OEMBED_TIMEOUT_MS = 3_000;

/** An oEmbed response is a small JSON document. Anything larger is not one. */
export const OEMBED_MAX_BYTES = 128 * 1024;

/** The thumbnail we store, at the width the media area renders. */
export const THUMBNAIL_WIDTH = 640;

export const THUMBNAIL_MAX_BYTES = 3 * 1024 * 1024;
export const THUMBNAIL_TIMEOUT_MS = 4_000;

/** Longest a title or author name may be before it is trimmed. */
export const TITLE_MAX = 300;
export const AUTHOR_MAX = 120;

/** A resolved embed is refreshed after this long, on the hourly job only. */
export const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * A failure is retried far less often than a success is refreshed — and an
 * `unavailable` never at all. A deleted post that is retried every cycle is an
 * outbound request forever, for an answer that will not change.
 */
export const RETRY_FAILED_AFTER_MS = 3 * 60 * 60 * 1000;

/** How many stale embeds one hourly pass will touch. */
export const REFRESH_BATCH = 10;

/** Wall-clock a single refresh pass may spend. See the avatar constant. */
export const REFRESH_BUDGET_MS = 20_000;
