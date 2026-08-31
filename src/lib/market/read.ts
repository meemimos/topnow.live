import { getDb } from "@/lib/db";
import { SLOTS, baseHrCents, type Slot } from "@/lib/pricing";

import { RANGES } from "./constants";
import { marketStateFor, toCandles, type Candle, type MarketState } from "./series";

/**
 * What the market panel needs, read once per request (#13).
 *
 * Three queries for three slots, not three per slot: the candle series, the
 * per-slot sample totals, and the sale counts. The panel is one component that
 * switches slot in the browser, so it is handed all three slots up front — a
 * fetch per click would re-read the database to show data the page already had,
 * and would flash the panel on every switch.
 *
 * The widest range is fetched, and narrower ranges are filtered from it in the
 * browser for the same reason.
 */

const MS_PER_HOUR = 3_600_000;

/** The longest range the controls offer. Everything narrower is a filter on it. */
const MAX_RANGE_HOURS = Math.max(...RANGES.map((range) => range.hours));

export type SlotMarket = {
  slot: Slot;
  baseHrCents: number;
  /** Candles inside the widest range, oldest first. Gaps are gaps. */
  candles: Candle[];
  /** The ask right now, from the newest candle — or base before anything is sampled. */
  askHrCents: number;
  state: MarketState;
};

export type Market = {
  slots: SlotMarket[];
  /** Whether any slot has crossed the reveal threshold. */
  anyRevealed: boolean;
};

export async function readMarket(now: Date = new Date()): Promise<Market> {
  const db = getDb();
  const from = new Date(now.getTime() - MAX_RANGE_HOURS * MS_PER_HOUR);

  const [samples, totals, sales] = await Promise.all([
    db.askSample.findMany({
      where: { hour: { gte: from } },
      orderBy: { hour: "asc" },
      select: { slot: true, hour: true, askHrCents: true, baseHrCents: true, queuedHours: true },
    }),
    // Total sampled hours and first-ever sample per slot. The threshold is on
    // every hour ever sampled, not on the hours inside the current range.
    db.askSample.groupBy({ by: ["slot"], _count: { _all: true }, _min: { hour: true } }),
    db.purchase.groupBy({ by: ["slot"], _count: { _all: true } }),
  ]);

  const slots = SLOTS.map((slot) => {
    const candles = toCandles(samples.filter((sample) => sample.slot === slot));
    const total = totals.find((row) => row.slot === slot);
    const firstHour = total?._min.hour ?? null;

    const state = marketStateFor({
      slot,
      candles,
      sampledHours: total?._count._all ?? 0,
      sales: sales.find((row) => row.slot === slot)?._count._all ?? 0,
      hoursOpen: firstHour ? (now.getTime() - firstHour.getTime()) / MS_PER_HOUR : null,
    });

    return {
      slot,
      baseHrCents: baseHrCents(slot),
      candles,
      // Before anything has been sampled the slot is at base, which is true
      // rather than a placeholder: an unsampled slot has never surged.
      askHrCents: candles[candles.length - 1]?.askHrCents ?? baseHrCents(slot),
      state,
    };
  });

  return { slots, anyRevealed: slots.some((slot) => slot.state.kind !== "sparse") };
}
