/**
 * How the counters are defined (#15).
 *
 * The issue asks for the counting method to be defensible and documented. These
 * constants *are* the definition, so they live together with the sentence each
 * one makes true.
 */

/**
 * A visit is one visitor in one thirty-minute window.
 *
 * Reloading ten times is one visit; coming back after lunch is a second. Half an
 * hour is the usual session window and it is chosen for being ordinary rather
 * than for producing a nicer number — a shorter window would inflate the count
 * for no reason, which is the direction that is not allowed.
 */
export const VISIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Online now is a visitor whose last page render was within five minutes.
 *
 * Not "has a socket open": there is no socket. It is the honest reading of what
 * the server actually observes, and it is what the label has to mean.
 */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * How long a counted value is served from cache before it is read again.
 *
 * The issue's rule is that a page render must never trigger a counting query. At
 * most one query per interval crosses the whole process, however many people are
 * looking.
 */
export const COUNTS_CACHE_MS = 10 * 1000;

/**
 * Seven digits, zero-padded, as the prototype has it.
 *
 * Padding is presentation. A real three shows as 0000003, and that is the joke
 * working correctly — an inflated three would be a lie told in the same space.
 */
export const ODOMETER_DIGITS = 7;

/** Ceiling for what the odometer can display, for the overflow case. */
export const ODOMETER_MAX = 10 ** ODOMETER_DIGITS - 1;
