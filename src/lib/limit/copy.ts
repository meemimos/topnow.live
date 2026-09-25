import { describeWait } from "./policy";

/**
 * What a refused caller is told (#18).
 *
 * The issue is specific about this: not a raw 429 page, not a silent no-op, but
 * the product's own error treatment with copy that explains what happened. So
 * the wording lives here rather than being written three times at three call
 * sites, and every message follows the same shape:
 *
 *   1. what was refused, in the second person
 *   2. that it is a pace limit rather than a rejection of the thing itself
 *   3. when to try again, as a duration rather than a timestamp
 *
 * Point 2 matters most. "Too many requests" reads as *your listing was refused*,
 * which is the one thing that has not happened — and a buyer who believes their
 * handle or their card was rejected does not come back in four minutes.
 */

export function checkoutLimited(retryAfterMs: number): string {
  return (
    `That is a lot of checkouts from one place in a short time, so this one is being ` +
    `held back — nothing is wrong with the listing. Try again in ${describeWait(retryAfterMs)}.`
  );
}

export function reportLimited(retryAfterMs: number): string {
  return (
    `You have sent several reports already; this one was not recorded. Reports are ` +
    `paced so the report box cannot be used to flood us. Try again in ` +
    `${describeWait(retryAfterMs)}.`
  );
}

export function adminLimited(retryAfterMs: number): string {
  return `Too many sign-in attempts. Try again in ${describeWait(retryAfterMs)}.`;
}
