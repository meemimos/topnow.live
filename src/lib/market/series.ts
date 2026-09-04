import { formatMoney } from "@/lib/pricing/format";
import type { Slot } from "@/lib/pricing";

import {
  FLAT_TOLERANCE,
  FLAT_WINDOW_CANDLES,
  MARKET_REVEAL_HOURS,
  type RangeHours,
} from "./constants";
import { sampleToMultiplierCm } from "./ask";

/**
 * The candle series, and the states a thin one can be in (#13).
 *
 * Built before the chart, deliberately. On day one the sparse state is the only
 * market state that exists, and a sparse state written as an afterthought reads
 * as a failure. Designed first, it reads as a market that has not opened yet.
 *
 * ## The hard rule
 *
 * **Never interpolate. Never pad. Never carry a value forward to fake
 * continuity.** One sample in, one candle out — an hour nobody sampled is an
 * hour with no candle, and it stays that way. `toCandles` is a `map`, and it is
 * a `map` on purpose: there is no branch anywhere in this file that could invent
 * an hour, which is the property a test pins rather than a convention a reviewer
 * has to remember.
 *
 * The credibility of the chart, the tape and the surge all rest on the numbers
 * being real. This audience will spot one fake line and discount the rest.
 */

export type Candle = {
  /** Top of the hour this candle covers, epoch ms. */
  hourMs: number;
  askHrCents: number;
  baseHrCents: number;
  queuedHours: number;
  /** The ask as a multiplier of base, in hundredths. */
  multiplierCm: number;
};

/** What `toCandles` needs from a sample. Structural, so tests need no database row. */
export type SampleLike = {
  hour: Date;
  askHrCents: number;
  baseHrCents: number;
  queuedHours: number;
};

/**
 * One candle per sample, in the order given.
 *
 * A `map` and nothing else. Gaps in the input stay gaps in the output: if the
 * hourly job missed 3am, there is no 3am candle and nothing here will make one.
 */
export function toCandles(samples: readonly SampleLike[]): Candle[] {
  return samples.map((sample) => ({
    hourMs: sample.hour.getTime(),
    askHrCents: sample.askHrCents,
    baseHrCents: sample.baseHrCents,
    queuedHours: sample.queuedHours,
    multiplierCm: sampleToMultiplierCm(sample),
  }));
}

/**
 * Trims a series to a range, by time rather than by count.
 *
 * By count would silently paper over gaps: "the last 12 candles" of a series
 * with six missing hours reaches eighteen hours back while claiming twelve.
 */
export function withinRange(
  candles: readonly Candle[],
  rangeHours: RangeHours,
  now: Date,
): Candle[] {
  const from = now.getTime() - rangeHours * 3_600_000;
  return candles.filter((candle) => candle.hourMs >= from);
}

/** Whether a candle sits within the flat tolerance of its own base rate. */
export function isAtBase(candle: Candle): boolean {
  const drift = Math.abs(candle.askHrCents - candle.baseHrCents);
  return drift <= candle.baseHrCents * FLAT_TOLERANCE;
}

/**
 * Whether a slot has been sitting at base.
 *
 * The trailing `FLAT_WINDOW_CANDLES` must all be within tolerance, and there
 * must be that many — five candles at base is not yet six hours of evidence, and
 * claiming otherwise would put a number in the copy that the data does not
 * support.
 */
export function isFlat(candles: readonly Candle[]): boolean {
  if (candles.length < FLAT_WINDOW_CANDLES) return false;
  return candles.slice(-FLAT_WINDOW_CANDLES).every(isAtBase);
}

export type MarketState =
  /** Too few sampled hours to draw anything. Says what has actually happened instead. */
  | {
      kind: "sparse";
      slot: Slot;
      /** Real purchases on this slot. Zero is a normal value here. */
      sales: number;
      /** Hours since the slot's first sample, or null before it has ever traded. */
      hoursOpen: number | null;
      sampledHours: number;
    }
  /** Enough data, and the slot has been at base throughout the flat window. */
  | { kind: "flat"; slot: Slot; candles: Candle[]; baseHrCents: number; queuedHours: number }
  /** Enough data, and it is moving. #12 draws this. */
  | { kind: "chart"; slot: Slot; candles: Candle[] };

/**
 * Which state the panel is in for a slot.
 *
 * The threshold is on *sampled hours*, not on how many candles survived the
 * range filter — a slot with forty hours of history looked at through a 12-hour
 * window is not a sparse market, it is a short view of a real one.
 */
export function marketStateFor({
  slot,
  candles,
  sampledHours,
  sales,
  hoursOpen,
}: {
  slot: Slot;
  candles: Candle[];
  sampledHours: number;
  sales: number;
  hoursOpen: number | null;
}): MarketState {
  if (sampledHours < MARKET_REVEAL_HOURS) {
    return { kind: "sparse", slot, sales, hoursOpen, sampledHours };
  }

  if (isFlat(candles)) {
    const last = candles[candles.length - 1]!;
    return {
      kind: "flat",
      slot,
      candles,
      baseHrCents: last.baseHrCents,
      queuedHours: last.queuedHours,
    };
  }

  return { kind: "chart", slot, candles };
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/**
 * Small numbers as words, so prose reads as prose.
 *
 * Driven by the constants rather than written into the copy, so that changing
 * `FLAT_WINDOW_CANDLES` cannot leave the sentence claiming six hours of evidence
 * the check no longer requires.
 */
export function inWords(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function hoursPhrase(hours: number): string {
  if (hours < 1) return "less than an hour ago";
  const whole = Math.floor(hours);
  return whole === 1 ? "an hour ago" : `${inWords(whole)} hours ago`;
}

/** `SLOT 01` -> `Slot 01`, for prose rather than a label. */
function slotProse(slot: Slot): string {
  return `Slot ${String(slot).padStart(2, "0")}`;
}

/**
 * The sparse note's first line. Every number in it is real.
 *
 * Zero sales is a normal reading, not an edge case to apologise for — it is what
 * launch day looks like, and it still says something true about the slot.
 */
export function sparseSentence(state: Extract<MarketState, { kind: "sparse" }>): string {
  const who = slotProse(state.slot);

  if (state.hoursOpen === null) {
    return `${who} has not opened yet. Nothing has been sampled on it.`;
  }

  const when = hoursPhrase(state.hoursOpen);
  if (state.sales === 0) {
    return `${who} has taken no sales since it opened ${when}.`;
  }
  const sales = state.sales === 1 ? "1 sale" : `${state.sales} sales`;
  return `${who} has taken ${sales} since it opened ${when}.`;
}

/**
 * The flat note. A positive statement about availability, not an error.
 *
 * The "no queue" half is only claimed when the data supports it: at base implies
 * no surge, but the sentence should not assert an empty queue it has not checked.
 */
export function flatSentence(state: Extract<MarketState, { kind: "flat" }>): string {
  const hours = inWords(FLAT_WINDOW_CANDLES);
  const rate = `${formatMoney(state.baseHrCents)}/hr`;
  const opening = `${slotProse(state.slot)} has sat at its base rate of ${rate} for the last ${hours} hours.`;

  return state.queuedHours === 0
    ? `${opening} No queue, no surge — it is available at base right now.`
    : `${opening} No surge — it is at base right now.`;
}

/**
 * A candle in the shape Lightweight Charts wants. Time is **seconds**, not ms.
 */
export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

/** Integer cents to whole units, for a chart axis that reads in dollars. */
function toUnits(cents: number): number {
  return cents / 100;
}

/**
 * Candles from the sampled ask.
 *
 * ## What a candle can honestly mean here
 *
 * There is exactly one observation per hour — the ask, sampled by #22. There is
 * no intra-hour data, so there is no observed high or low to draw.
 *
 * So a candle here means *"between the last observation and this one, the ask
 * moved from open to close"*, and `high`/`low` are the endpoints of that move.
 * They are not invented extremes: they are the largest and smallest values
 * actually observed over the candle's span. A candle body with no wick is the
 * truthful rendering of a series sampled once an hour, and it still carries the
 * one thing the chart is for — direction, filled up and hollow down.
 *
 * Inventing a wider high or low to make the chart look like a traded market is
 * exactly the padding this codebase refuses.
 *
 * ## Gaps
 *
 * `open` is the previous *sample*, not the previous hour. If the sampler missed
 * three hours, the next candle opens at the last value actually observed and
 * spans the gap — which is what happened. Nothing is inserted to bridge it, so
 * the series still has one candle per sample and the gap stays visible on the
 * time axis.
 *
 * The first candle has nothing before it, so it opens where it closes. A doji is
 * the honest rendering of a single observation.
 */
export function toBars(candles: readonly Candle[]): Bar[] {
  return candles.map((candle, index) => {
    const close = toUnits(candle.askHrCents);
    const open = index === 0 ? close : toUnits(candles[index - 1]!.askHrCents);

    return {
      // Lightweight Charts' UTCTimestamp is in seconds.
      time: Math.floor(candle.hourMs / 1000),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    };
  });
}

/**
 * Sale markers, snapped to the candle that contains them.
 *
 * A marker whose time does not match an existing data point is dropped silently
 * by the library, so this drops them deliberately instead: a sale in an hour
 * nobody sampled has no candle to sit under, and inventing that candle to give
 * it somewhere to land is the one thing this module will not do.
 *
 * Deduplicated, because several sales can land in the same hour and the library
 * requires unique ascending times.
 */
export function saleMarkerTimes(saleMs: readonly number[], candles: readonly Candle[]): number[] {
  const hours = new Set(candles.map((candle) => candle.hourMs));
  const matched = new Set<number>();

  for (const at of saleMs) {
    const hour = Math.floor(at / 3_600_000) * 3_600_000;
    if (hours.has(hour)) matched.add(Math.floor(hour / 1000));
  }

  return [...matched].sort((a, b) => a - b);
}
