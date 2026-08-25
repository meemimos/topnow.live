/**
 * The pricing engine (#2).
 *
 * One pure module. No I/O, no clock of its own — anything time-dependent takes
 * the relevant value as an argument, so every result is deterministic and
 * testable. **Every price displayed anywhere in the app comes from here.**
 *
 *     total = base_rate x surge x hours
 *
 * Flat hourly rate: no volume discount, no duration premium. A discount would
 * reward exactly the squatting this model exists to prevent, and it would break
 * the chart by moving price independently of demand.
 *
 * ## Why multipliers are quantised to hundredths
 *
 * The receipt (#9) prints its own derivation — "$5.00 BASE x 1.67 SURGE x 3H" —
 * so a buyer can check the arithmetic. If the engine used the unrounded ratio
 * (1.6667) while the receipt displayed 1.67, the printed sum would not equal the
 * printed total and the receipt would look wrong.
 *
 * So the multiplier is quantised to hundredths *before* it prices anything: the
 * multiplier shown is the multiplier used. Base rates are whole dollars, so
 * base x multiplier lands exactly on a cent with nothing to round.
 */
import {
  BASE_MULTIPLIER_CM,
  DECAY_RETAINED_PER_HOUR,
  DURATION_HOURS,
  MAX_MULTIPLIER_CM,
  QUEUE_CAP_HOURS,
  SLOT_BASE_HR_CENTS,
  type DurationHours,
  type Slot,
} from "./constants";

export * from "./constants";

export type Quote = {
  slot: Slot;
  durationH: DurationHours;
  /** The slot's flat rate, before surge. */
  baseHrCents: number;
  /** Multiplier in hundredths: 167 is 1.67x. */
  multiplierCm: number;
  /** The ask: what this hour actually costs. Locked into the purchase at checkout. */
  askHrCents: number;
  /** askHrCents x durationH. Exactly, which the database also enforces. */
  totalCents: number;
};

export function isSlot(value: number): value is Slot {
  return value === 1 || value === 2 || value === 3;
}

export function isDurationHours(value: number): value is DurationHours {
  return (DURATION_HOURS as readonly number[]).includes(value);
}

export function baseHrCents(slot: Slot): number {
  return SLOT_BASE_HR_CENTS[slot];
}

/**
 * Surge from the hours currently queued on a slot, in hundredths.
 *
 *     100 (1.00x) at an empty queue, 200 (2.00x) at the cap and beyond.
 *
 * Queued hours below zero are treated as zero rather than throwing: the caller
 * is summing durations, and a negative sum means a bug upstream that should not
 * take the board down.
 */
export function surgeFromQueuedHours(queuedHours: number): number {
  const hours = Math.max(0, queuedHours);
  const raw = BASE_MULTIPLIER_CM + Math.round((hours * BASE_MULTIPLIER_CM) / QUEUE_CAP_HOURS);
  return Math.min(raw, MAX_MULTIPLIER_CM);
}

/**
 * One hour of decay on a slot that did not sell.
 *
 * The ask retains 95% of its distance above base each unsold hour, and never
 * falls below whatever the current queue justifies — demand pushes the ask up
 * immediately, and only time brings it back down.
 *
 * Floors rather than rounds, so the last cent of surge actually decays away
 * instead of parking one hundredth above base forever.
 */
export function decayOneHour(previousCm: number, queuedHours: number): number {
  const above = Math.max(0, previousCm - BASE_MULTIPLIER_CM);
  const decayed = BASE_MULTIPLIER_CM + Math.floor(above * DECAY_RETAINED_PER_HOUR);
  return Math.max(surgeFromQueuedHours(queuedHours), decayed);
}

/** Applies `hours` of decay in sequence. `hours` of 0 returns the input unchanged. */
export function decayOver(previousCm: number, hours: number, queuedHours: number): number {
  let current = previousCm;
  for (let i = 0; i < Math.max(0, Math.floor(hours)); i += 1) {
    current = decayOneHour(current, queuedHours);
  }
  return current;
}

/** The ask for a slot at a given multiplier, in cents per hour. */
export function askHrCents(slot: Slot, multiplierCm: number): number {
  return Math.round((baseHrCents(slot) * multiplierCm) / BASE_MULTIPLIER_CM);
}

/**
 * The complete quote for a checkout.
 *
 * `multiplierCm` is passed in rather than derived, because the caller decides
 * whether it is the live ask (a new checkout) or the rate locked into an
 * existing purchase (rendering a receipt for something already bought). Nobody
 * already queued is ever re-priced.
 */
export function quote(slot: Slot, durationH: DurationHours, multiplierCm: number): Quote {
  const perHour = askHrCents(slot, multiplierCm);
  return {
    slot,
    durationH,
    baseHrCents: baseHrCents(slot),
    multiplierCm,
    askHrCents: perHour,
    totalCents: perHour * durationH,
  };
}

/** The quote for buying into a slot right now, given what is queued on it. */
export function quoteForQueue(
  slot: Slot,
  durationH: DurationHours,
  queuedHours: number,
  /** The slot's decayed ask, if it carries one above what the queue justifies. */
  currentMultiplierCm?: number,
): Quote {
  const fromQueue = surgeFromQueuedHours(queuedHours);
  return quote(slot, durationH, Math.max(fromQueue, currentMultiplierCm ?? fromQueue));
}
