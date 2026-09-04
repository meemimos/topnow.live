import { describe, expect, it } from "vitest";

import { baseHrCents, type Slot } from "@/lib/pricing";

import { FLAT_TOLERANCE, FLAT_WINDOW_CANDLES, MARKET_REVEAL_HOURS } from "./constants";
import {
  flatSentence,
  inWords,
  isFlat,
  marketStateFor,
  sparseSentence,
  saleMarkerTimes,
  toBars,
  toCandles,
  withinRange,
  type Candle,
  type SampleLike,
} from "./series";

const HOUR = 3_600_000;
const NOW = new Date("2026-08-25T12:00:00.000Z");

/** A sample at `hoursAgo`, asking `askHrCents` on `slot`. */
function sample(slot: Slot, hoursAgo: number, ask: number, queuedHours = 0): SampleLike {
  return {
    hour: new Date(NOW.getTime() - hoursAgo * HOUR),
    askHrCents: ask,
    baseHrCents: baseHrCents(slot),
    queuedHours,
  };
}

/** `n` consecutive hourly samples at base, oldest first. */
function atBase(slot: Slot, n: number, queuedHours = 0): SampleLike[] {
  return Array.from({ length: n }, (_, i) => sample(slot, n - i, baseHrCents(slot), queuedHours));
}

describe("nothing invents a candle", () => {
  /**
   * The acceptance criterion #13 names explicitly. A gappy series has to survive
   * intact: an hour the sampler missed is an hour with no candle, permanently.
   */
  it("produces exactly one candle per sample, gaps and all", () => {
    const gappy: SampleLike[] = [
      sample(1, 10, 500),
      sample(1, 9, 500),
      // 8, 7 and 6 hours ago missing — the job did not run.
      sample(1, 5, 550),
      sample(1, 2, 500),
    ];

    const candles = toCandles(gappy);

    expect(candles).toHaveLength(gappy.length);
    expect(candles.map((c) => c.hourMs)).toEqual(gappy.map((s) => s.hour.getTime()));
  });

  it("leaves the gap in place rather than filling it", () => {
    const candles = toCandles([sample(1, 5, 500), sample(1, 2, 500)]);

    // Three hours apart, two candles. Nothing between them.
    expect(candles).toHaveLength(2);
    expect(candles[1]!.hourMs - candles[0]!.hourMs).toBe(3 * HOUR);
  });

  it("returns nothing for no samples, rather than a placeholder", () => {
    expect(toCandles([])).toEqual([]);
  });

  it("never lengthens a series, at any length", () => {
    for (const n of [0, 1, 2, 7, 20, 51]) {
      const samples = Array.from({ length: n }, (_, i) => sample(1, n - i, 500));
      expect(toCandles(samples)).toHaveLength(n);
    }
  });
});

describe("range trimming", () => {
  /**
   * Trimmed by time, not by count. "The last 12 candles" of a gappy series
   * reaches further back than twelve hours while claiming not to.
   */
  it("trims by time so a gappy series does not over-reach", () => {
    const candles = toCandles([
      sample(1, 30, 500),
      sample(1, 20, 500),
      sample(1, 6, 500),
      sample(1, 1, 500),
    ]);

    const trimmed = withinRange(candles, 12, NOW);
    expect(trimmed).toHaveLength(2);
    expect(trimmed.every((c) => c.hourMs >= NOW.getTime() - 12 * HOUR)).toBe(true);
  });

  it("does not pad a range that has fewer candles than hours", () => {
    const candles = toCandles([sample(1, 2, 500)]);
    expect(withinRange(candles, 24, NOW)).toHaveLength(1);
  });
});

describe("flat detection", () => {
  it("fires when the whole window sits at base", () => {
    expect(isFlat(toCandles(atBase(3, FLAT_WINDOW_CANDLES)))).toBe(true);
  });

  it("does not fire on fewer candles than the window, even if all are at base", () => {
    expect(isFlat(toCandles(atBase(3, FLAT_WINDOW_CANDLES - 1)))).toBe(false);
  });

  it("does not fire when a candle inside the window is above tolerance", () => {
    const samples = atBase(3, FLAT_WINDOW_CANDLES);
    // 10% above base, comfortably outside the 1.5% band.
    samples[2] = sample(3, 4, Math.round(baseHrCents(3) * 1.1));
    expect(isFlat(toCandles(samples))).toBe(false);
  });

  it("tolerates drift just inside the band and rejects it just outside", () => {
    const base = baseHrCents(1);
    const inside = Math.round(base * (1 + FLAT_TOLERANCE) - 1);
    const outside = Math.round(base * (1 + FLAT_TOLERANCE) + 2);

    const near = Array.from({ length: FLAT_WINDOW_CANDLES }, (_, i) =>
      sample(1, FLAT_WINDOW_CANDLES - i, inside),
    );
    expect(isFlat(toCandles(near))).toBe(true);

    near[0] = sample(1, FLAT_WINDOW_CANDLES, outside);
    expect(isFlat(toCandles(near))).toBe(false);
  });

  /** Only the trailing window counts — a slot that surged yesterday is flat today. */
  it("looks only at the trailing window", () => {
    const samples = [sample(1, 20, 900), ...atBase(1, FLAT_WINDOW_CANDLES)];
    expect(isFlat(toCandles(samples))).toBe(true);
  });
});

describe("which state the panel is in", () => {
  const enough = MARKET_REVEAL_HOURS;

  it("is sparse below the reveal threshold, however much it moved", () => {
    const state = marketStateFor({
      slot: 1,
      candles: toCandles([sample(1, 2, 900), sample(1, 1, 500)]),
      sampledHours: enough - 1,
      sales: 3,
      hoursOpen: 6,
    });
    expect(state.kind).toBe("sparse");
  });

  it("is flat at the threshold when the window is at base", () => {
    const state = marketStateFor({
      slot: 3,
      candles: toCandles(atBase(3, FLAT_WINDOW_CANDLES)),
      sampledHours: enough,
      sales: 2,
      hoursOpen: 20,
    });
    expect(state.kind).toBe("flat");
  });

  it("is a chart once there is enough data and it is moving", () => {
    const samples = [...atBase(1, FLAT_WINDOW_CANDLES), sample(1, 0, 900)];
    const state = marketStateFor({
      slot: 1,
      candles: toCandles(samples),
      sampledHours: enough + 5,
      sales: 9,
      hoursOpen: 25,
    });
    expect(state.kind).toBe("chart");
  });

  /**
   * The threshold is on sampled hours, not on how many candles survived the
   * range filter — a slot with forty hours of history seen through a 12-hour
   * window is a short view of a real market, not a sparse one.
   */
  it("does not fall back to sparse because the range is short", () => {
    const state = marketStateFor({
      slot: 1,
      candles: toCandles([sample(1, 2, 900), sample(1, 1, 500)]),
      sampledHours: enough + 20,
      sales: 40,
      hoursOpen: 40,
    });
    expect(state.kind).toBe("chart");
  });
});

describe("the sparse note says what actually happened", () => {
  function sparse(sales: number, hoursOpen: number | null) {
    const state = marketStateFor({
      slot: 1,
      candles: [],
      sampledHours: 3,
      sales,
      hoursOpen,
    });
    if (state.kind !== "sparse") throw new Error("expected sparse");
    return sparseSentence(state);
  }

  it("states the real sale count and the real hours since opening", () => {
    expect(sparse(3, 6)).toBe("Slot 01 has taken 3 sales since it opened six hours ago.");
  });

  /** Launch day. Zero is a normal reading, not something to apologise for. */
  it("reads sensibly at zero sales", () => {
    expect(sparse(0, 2)).toBe("Slot 01 has taken no sales since it opened two hours ago.");
  });

  it("says a slot has not opened when nothing has been sampled", () => {
    expect(sparse(0, null)).toBe("Slot 01 has not opened yet. Nothing has been sampled on it.");
  });

  it("gets the singulars right", () => {
    expect(sparse(1, 1)).toBe("Slot 01 has taken 1 sale since it opened an hour ago.");
  });

  it("does not claim a whole hour before one has passed", () => {
    expect(sparse(1, 0.4)).toContain("less than an hour ago");
  });
});

describe("the flat note reads as availability", () => {
  function flat(queuedHours: number) {
    const state = marketStateFor({
      slot: 3,
      candles: toCandles(atBase(3, FLAT_WINDOW_CANDLES, queuedHours)),
      sampledHours: MARKET_REVEAL_HOURS,
      sales: 1,
      hoursOpen: 20,
    });
    if (state.kind !== "flat") throw new Error("expected flat");
    return flatSentence(state);
  }

  it("states the real base rate and invites a purchase", () => {
    expect(flat(0)).toBe(
      "Slot 03 has sat at its base rate of $2.00/hr for the last six hours. " +
        "No queue, no surge — it is available at base right now.",
    );
  });

  /** It should not assert an empty queue it has not checked. */
  it("drops the no-queue claim when something is queued", () => {
    const sentence = flat(2);
    expect(sentence).not.toContain("No queue");
    expect(sentence).toContain("No surge — it is at base right now.");
  });

  it("spells the window from the constant rather than hard-coding it", () => {
    // If FLAT_WINDOW_CANDLES changes, the copy has to follow it rather than
    // going on claiming six hours of evidence the check no longer requires.
    expect(flat(0)).toContain(`for the last ${inWords(FLAT_WINDOW_CANDLES)} hours`);
  });
});

describe("candles carry the multiplier that produced them", () => {
  it("derives the multiplier from ask against base", () => {
    const candles: Candle[] = toCandles([sample(1, 1, 750)]);
    // $7.50 against a $5.00 base is 1.50x.
    expect(candles[0]!.multiplierCm).toBe(150);
  });
});

describe("candles carry only what was observed", () => {
  /**
   * There is one observation per hour, so a candle's high and low are the
   * endpoints of the move — not invented extremes. A body with no wick is the
   * truthful rendering of a series sampled once an hour.
   */
  it("draws no wick, because no intra-hour extreme was ever observed", () => {
    const bars = toBars(toCandles([sample(1, 3, 500), sample(1, 2, 700), sample(1, 1, 600)]));

    for (const bar of bars) {
      expect(bar.high).toBe(Math.max(bar.open, bar.close));
      expect(bar.low).toBe(Math.min(bar.open, bar.close));
    }
  });

  it("opens each candle at the previous sample and closes at its own", () => {
    const bars = toBars(toCandles([sample(1, 3, 500), sample(1, 2, 700)]));

    expect(bars[1]).toMatchObject({ open: 5, close: 7, high: 7, low: 5 });
  });

  /** A single observation is a doji. Anything else would be invented movement. */
  it("opens the first candle where it closes", () => {
    const [first] = toBars(toCandles([sample(1, 1, 500)]));
    expect(first).toMatchObject({ open: 5, close: 5, high: 5, low: 5 });
  });

  it("spans a gap rather than bridging it", () => {
    // Sampled at 10h and 2h ago; nothing in between.
    const bars = toBars(toCandles([sample(1, 10, 500), sample(1, 2, 800)]));

    expect(bars).toHaveLength(2);
    // The later candle opens at the last value actually observed, which is what
    // happened — no candles are inserted across the gap to smooth it.
    expect(bars[1]!.open).toBe(5);
    expect(bars[1]!.close).toBe(8);
  });

  it("emits times in seconds, ascending and unique", () => {
    const bars = toBars(toCandles([sample(1, 3, 500), sample(1, 2, 600), sample(1, 1, 700)]));
    const times = bars.map((b) => b.time);

    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    // Seconds, not milliseconds — the library's UTCTimestamp.
    expect(times[0]).toBe(Math.floor((NOW.getTime() - 3 * HOUR) / 1000));
  });

  it("produces exactly one bar per candle", () => {
    const candles = toCandles(Array.from({ length: 9 }, (_, i) => sample(1, 9 - i, 500)));
    expect(toBars(candles)).toHaveLength(candles.length);
  });
});

describe("sale markers come from real purchases", () => {
  const candles = toCandles([sample(1, 3, 500), sample(1, 2, 600), sample(1, 1, 700)]);
  const hourMs = (hoursAgo: number) => NOW.getTime() - hoursAgo * HOUR;

  it("snaps a sale to the candle whose hour contains it", () => {
    // Twenty minutes into the hour sampled two hours ago.
    const times = saleMarkerTimes([hourMs(2) + 20 * 60_000], candles);
    expect(times).toEqual([Math.floor(hourMs(2) / 1000)]);
  });

  /**
   * A marker whose time has no data point is dropped silently by the library.
   * Dropping it deliberately is the honest alternative to inventing the candle
   * it would need to land on.
   */
  it("drops a sale that happened in an unsampled hour", () => {
    expect(saleMarkerTimes([hourMs(40)], candles)).toEqual([]);
  });

  it("collapses several sales in one hour to a single marker", () => {
    const times = saleMarkerTimes([hourMs(2), hourMs(2) + 60_000, hourMs(2) + 120_000], candles);
    expect(times).toHaveLength(1);
  });

  it("returns markers ascending, as the library requires", () => {
    const times = saleMarkerTimes([hourMs(1), hourMs(3), hourMs(2)], candles);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times).toHaveLength(3);
  });

  it("returns nothing when there are no sales", () => {
    expect(saleMarkerTimes([], candles)).toEqual([]);
  });
});
