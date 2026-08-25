/**
 * Every number the pricing model depends on. Nothing else in the app declares a
 * rate, a duration, or a multiplier.
 */

/** Integer cents throughout. Money is never a float. */
export const SLOT_BASE_HR_CENTS = {
  1: 500,
  2: 300,
  3: 200,
} as const;

export type Slot = keyof typeof SLOT_BASE_HR_CENTS;
export const SLOTS = [1, 2, 3] as const satisfies readonly Slot[];

/**
 * Durations are snap points, never an arbitrary number of hours. The names are
 * the prototype's and carry the product's voice — surface them in the picker (#8).
 */
export const DURATIONS = [
  { hours: 1, name: "Quick flex" },
  { hours: 3, name: "Lunch to dinner" },
  { hours: 6, name: "Half a day" },
  { hours: 12, name: "Overnight" },
  { hours: 24, name: "Own the day" },
] as const;

export type DurationHours = (typeof DURATIONS)[number]["hours"];
export const DURATION_HOURS = DURATIONS.map((d) => d.hours) as readonly DurationHours[];

/**
 * Decision D2, as amended after the scenario harness (`npm run scenarios`)
 * showed the original 18-hour value failing its own guarantee.
 *
 * Surge is driven by total queued hours, not head count — what a buyer
 * experiences is the wait, and four people booking 24h each is a 96-hour queue
 * while four booking 1h each is a four-hour one.
 *
 *     multiplier = 1 + min(queued_hours / QUEUE_CAP_HOURS, 1.0)
 *
 * The same constant caps the wait in #24, so a slot at the ceiling is both at
 * 2.00x and about to stop accepting bookings.
 *
 * ## Why 24 and not 18
 *
 * At 18 the scenarios produced a buyer waiting 19.4 hours: the cap counted
 * queued hours but ignored the time left on the rental currently on the board.
 * The worst case was a fresh 24h rental plus 18 queued hours — a 42-hour wait,
 * exactly the multi-day wait #24 exists to prevent.
 *
 * #24 now caps live-remaining plus queued, and 24 hours is the value that keeps
 * the 24h booking buyable on an empty slot while making the maximum wait a true
 * day. At 18 a slot whose 24h rental had just started would have accepted no
 * bookings at all for its first six hours.
 *
 * The cost, accepted deliberately: slot 01 at the prototype's own queue depth of
 * 12 queued hours is now 1.50x / $7.50/hr rather than 1.67x / $8.35, so it sits
 * further from the mockup's $8.50.
 */
export const QUEUE_CAP_HOURS = 24;

/** Surge never exceeds this. Reached exactly at QUEUE_CAP_HOURS. */
export const MAX_MULTIPLIER_CM = 200;

/** Base, in the same centi-multiplier units. 100 = 1.00x. */
export const BASE_MULTIPLIER_CM = 100;

/**
 * A slot unsold for an hour drops its ask 5% toward base.
 *
 * Decay only means anything because the ask carries memory: if the multiplier
 * were a pure function of the current queue, an empty queue would already be
 * 1.00x and there would be nothing to decay. The ask jumps up with demand and
 * bleeds back down, which is what makes the chart behave like a market rather
 * than a step function. #22 advances it hourly.
 */
export const DECAY_RETAINED_PER_HOUR = 0.95;
