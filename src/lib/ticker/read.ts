import "server-only";

import { getDb } from "@/lib/db";

import { MAX_EVENTS, buildTicker, type TickerEvent } from "./events";

/**
 * Reading the ticker (#16).
 *
 * Two bounded queries on the page's own render — not a polling endpoint, and not
 * a client that asks again every few seconds. The strip is part of the page,
 * so it costs what the page costs and nothing more.
 *
 * Both queries are capped rather than time-windowed. A time window would empty
 * the strip on a quiet week, and the issue is explicit that a quiet ticker says
 * the last real thing that happened rather than falling silent because the last
 * real thing was yesterday.
 */

/**
 * How many rows to consider.
 *
 * More than `MAX_EVENTS` because one purchase can produce three events and one
 * hour of samples can produce none — so the strip needs a pool to select the
 * most recent handful from, not exactly as many rows as it will show.
 */
const PURCHASE_POOL = 40;
const SAMPLE_POOL = 120;

export async function readTicker(
  now: Date = new Date(),
  limit = MAX_EVENTS,
): Promise<TickerEvent[]> {
  const db = getDb();

  const [purchases, samples] = await Promise.all([
    db.purchase.findMany({ orderBy: { boughtAt: "desc" }, take: PURCHASE_POOL }),
    // Ordered descending to get the *recent* samples, then `priceEvents` sorts
    // each slot ascending again — a change is only visible between neighbours,
    // and neighbours have to be in time order to be compared.
    db.askSample.findMany({ orderBy: { hour: "desc" }, take: SAMPLE_POOL }),
  ]);

  return buildTicker(purchases, samples, now, limit);
}
