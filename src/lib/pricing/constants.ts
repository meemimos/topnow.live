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
 * Decision D2.
 *
 * Surge is driven by total queued hours, not head count — what a buyer
 * experiences is the wait, and four people booking 24h each is a 96-hour queue
 * while four booking 1h each is a four-hour one.
 *
 *     multiplier = 1 + min(queued_hours / QUEUE_CAP_HOURS, 1.0)
 *
 * The same constant caps the wait in #24: a slot stops accepting bookings once
 * more than this many hours are already queued, so the multiplier reads directly
 * as how close the slot is to closing, and there is one constant instead of two.
 *
 * 18 hours reproduces the prototype's headline multiplier at its own queue depth
 * (12 queued hours -> 1.67x) and means nobody ever joins a wait longer than 18
 * hours. Note that the cap is on the wait a buyer inherits, not on the queue
 * itself — see src/lib/purchase/queue.ts for why, and for the consequence.
 */
export const QUEUE_CAP_HOURS = 18;

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
