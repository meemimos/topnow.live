/**
 * Rate-limit policies (#18).
 *
 * A policy is written as one string so a whole limit can live in one environment
 * variable and be changed without a deploy:
 *
 *     20/1h+5     twenty an hour, five may be spent back-to-back
 *     10/1m+3     ten a minute, three back-to-back
 *
 * ## Why the burst is not optional
 *
 * The issue's last acceptance line is the one that shapes this format: *"a user
 * correcting a typo and resubmitting twice is not blocked"*. A limiter written
 * as "N per window" with no burst allowance blocks exactly that person, because
 * a sustained rate of twenty an hour means one every three minutes and the
 * second submission arrives three seconds later.
 *
 * So the burst is a required part of the syntax rather than a defaulted extra.
 * Whoever sets a limit has to answer "how many in a row is obviously fine?" —
 * and that answer, not the sustained rate, is what decides whether the limit
 * hits abuse or hits haste.
 */

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** `count/window+burst`, e.g. `20/1h+5`. */
const SYNTAX = /^(\d+)\/(\d+)([smhd])\+(\d+)$/;

export class InvalidPolicyError extends Error {
  constructor(text: string, why: string) {
    super(`Invalid rate limit "${text}": ${why}. Expected e.g. "20/1h+5".`);
    this.name = "InvalidPolicyError";
  }
}

export type Policy = {
  /** Sustained allowance: `limit` requests per `windowMs`. */
  limit: number;
  windowMs: number;
  /** How many may be spent back-to-back before the sustained rate binds. */
  burst: number;
  /** What one request costs, in milliseconds of credit. */
  emissionMs: number;
  /** How far ahead of the sustained rate the bucket runs: `burst * emissionMs`. */
  toleranceMs: number;
};

export function parsePolicy(text: string): Policy {
  const match = SYNTAX.exec(text.trim());
  if (!match) throw new InvalidPolicyError(text, "unrecognised syntax");

  const limit = Number(match[1]);
  const window = Number(match[2]);
  const unit = match[3]!;
  const burst = Number(match[4]);

  if (limit < 1) throw new InvalidPolicyError(text, "the count must be at least 1");
  if (window < 1) throw new InvalidPolicyError(text, "the window must be at least 1");
  if (burst < 1) throw new InvalidPolicyError(text, "the burst must be at least 1");

  const windowMs = window * UNITS[unit]!;
  const emissionMs = windowMs / limit;

  return { limit, windowMs, burst, emissionMs, toleranceMs: burst * emissionMs };
}

/**
 * How long a refused caller is told to wait, in whole seconds.
 *
 * `Retry-After` is defined in seconds, and rounding up rather than down is the
 * honest direction: a value that expires a fraction early invites a second
 * refusal, which reads as the limiter lying about when it would let you back in.
 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}

/** "in about 4 minutes" — the phrasing the product uses when it refuses. */
export function describeWait(retryAfterMs: number): string {
  const seconds = retryAfterSeconds(retryAfterMs);
  if (seconds < 60) return `about ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}
