import type { AskSample } from "@prisma/client";

import { getDb } from "@/lib/db";
import {
  SLOTS,
  askHrCents,
  baseHrCents,
  decayOver,
  surgeFromQueuedHours,
  type Slot,
} from "@/lib/pricing";
import { refreshStaleAvatars, type RefreshSummary } from "@/lib/avatar/store";
import { refreshStaleEmbeds, type EmbedRefreshSummary } from "@/lib/embed/store";
import { pruneExpiredLimits } from "@/lib/limit/limiter";
import { promoteAll } from "@/lib/purchase/state";

import { latestSampledAsk } from "./ask";

/**
 * The hourly job (#22).
 *
 * ## What this job is NOT for
 *
 * Expiry. Liveness is derived from timestamps at read time (#1), so a rental
 * that should have ended has ended whether or not this ran. Making the job
 * responsible for `live -> ended` would make correctness depend on cron uptime,
 * and the board would lie across any restart or missed tick.
 *
 * This job therefore holds **no load-bearing state**. If it stops for an hour
 * the board stays correct and only the chart loses an hour of samples. That
 * property is the thing to protect: nothing the board depends on may creep in
 * here.
 *
 * ## What it does
 *
 * 1. Samples the hourly ask per slot — the series #12's candles are built from,
 *    and why the chart has a line even in an hour with no sales.
 * 2. Advances decay, by carrying the previous hour's ask forward through
 *    `decayOneHour`.
 * 3. Nudges promotion, so a slot freeing at 3am does not wait for a visitor.
 *    An optimisation, not a correctness requirement — the same transaction #1
 *    would run on the next read, just triggered earlier.
 * 4. Refreshes stale avatars (#19) and post embeds (#20). This is the *only*
 *    scheduled resolution point; a board render must never cause a third-party
 *    request, so the refresh has to live behind a clock rather than behind a
 *    visitor.
 */

const MS_PER_HOUR = 3_600_000;

const EMPTY_REFRESH = { considered: 0, resolved: 0, failed: 0 } as const;

/** Runs a non-essential part of the tick without letting it fail the tick. */
async function settled<T>(work: Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    console.warn(`[cron/hourly] ${label} refresh failed`, error);
    return fallback;
  }
}

/** Truncates to the top of the hour, which is the grain samples are stored at. */
export function truncateToHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MS_PER_HOUR) * MS_PER_HOUR);
}

export type SlotQueueState = { slot: Slot; queuedHours: number };

async function queuedHoursBySlot(): Promise<Map<Slot, number>> {
  const rows = await getDb().purchase.groupBy({
    by: ["slot"],
    where: { status: "queued" },
    _sum: { durationH: true },
  });

  const bySlot = new Map<Slot, number>(SLOTS.map((slot) => [slot, 0]));
  for (const row of rows) bySlot.set(row.slot as Slot, row._sum.durationH ?? 0);
  return bySlot;
}

/**
 * The multiplier a slot carries into `hour`.
 *
 * The ask has memory: it jumps up with demand immediately and bleeds 5% of its
 * distance above base per unsold hour. Without that, decay would never fire —
 * an empty queue is already 1.00x — and the chart would be a step function
 * rather than something that behaves like a market.
 *
 * The memory is the previous *sample*, not a mutable column, so the series is
 * reconstructible and a missed hour cannot corrupt the next one.
 *
 * Decay is applied for every hour actually elapsed since that sample, not for
 * one hour. Applying a single hour would let an outage freeze the ask near its
 * peak: come back after eight hours down and the slot would still be asking
 * within 5% of what it charged when it was busy.
 */
export async function multiplierForHour(
  slot: Slot,
  queuedHours: number,
  hour: Date,
): Promise<number> {
  const previous = await latestSampledAsk(getDb(), slot);
  if (!previous) return surgeFromQueuedHours(queuedHours);

  const hoursElapsed = Math.max(
    0,
    Math.round((hour.getTime() - previous.hour.getTime()) / MS_PER_HOUR),
  );

  return decayOver(previous.multiplierCm, hoursElapsed, queuedHours);
}

export type SampleResult = {
  hour: Date;
  written: AskSample[];
  /** Slots whose sample for this hour already existed. */
  skipped: Slot[];
};

/**
 * Writes one ask sample per slot for the hour containing `now`.
 *
 * Idempotent by constraint rather than by checking first: `ask_sample` is unique
 * on `(slot, hour)` (#21), so a repeat run or two concurrent runs produce one
 * row, not two.
 *
 * A missed hour stays missed. Nothing backfills or interpolates it — an hour
 * with no sample is an hour with no candle, and #13 renders that honestly.
 */
export async function sampleAsks(now: Date = new Date()): Promise<SampleResult> {
  const db = getDb();
  const hour = truncateToHour(now);
  const queued = await queuedHoursBySlot();

  const written: AskSample[] = [];
  const skipped: Slot[] = [];

  for (const slot of SLOTS) {
    const queuedHours = queued.get(slot) ?? 0;
    const multiplierCm = await multiplierForHour(slot, queuedHours, hour);

    try {
      written.push(
        await db.askSample.create({
          data: {
            slot,
            hour,
            askHrCents: askHrCents(slot, multiplierCm),
            baseHrCents: baseHrCents(slot),
            queuedHours,
          },
        }),
      );
    } catch (error) {
      // The unique constraint firing means this hour is already sampled, which
      // is success for an idempotent job rather than a failure.
      if (isUniqueViolation(error)) {
        skipped.push(slot);
        continue;
      }
      throw error;
    }
  }

  return { hour, written, skipped };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export type TickResult = {
  hour: Date;
  samplesWritten: number;
  samplesSkipped: number;
  promoted: number;
  avatars: RefreshSummary;
  embeds: EmbedRefreshSummary;
  /** Rate-limit buckets dropped because they had refilled (#18). */
  limitsPruned: number;
  ranAt: Date;
};

/**
 * One run of the hourly job.
 *
 * Promotion first, so this hour's sample reflects the queue as it stands after
 * anything that had already expired has been handed on.
 */
export async function runHourlyTick(now: Date = new Date()): Promise<TickResult> {
  const promoted = await promoteAll(now);
  const { hour, written, skipped } = await sampleAsks(now);

  // Last, and made unable to throw. The sample above is the part of this job
  // the chart depends on and an hour of it can never be recovered, so nothing
  // after it may fail the tick. `ensureAvatar` and `ensureEmbed` swallow their
  // own errors, but the queries that *choose* what to refresh do not — a
  // dropped connection there would have taken the whole run down with it.
  const avatars = await settled(refreshStaleAvatars(now), EMPTY_REFRESH, "avatars");
  const embeds = await settled(refreshStaleEmbeds(now), EMPTY_REFRESH, "embeds");

  // Housekeeping, and safe to skip: a bucket past its expiry permits exactly
  // what a missing row permits, so a failed prune leaves rows behind and changes
  // no decision.
  const limitsPruned = await settled(pruneExpiredLimits(now), 0, "rate limit");

  return {
    hour,
    samplesWritten: written.length,
    samplesSkipped: skipped.length,
    promoted: promoted.length,
    avatars,
    embeds,
    limitsPruned,
    ranAt: now,
  };
}

/**
 * Hours of sampled ask on a slot.
 *
 * Decision D3 gates the market panel on twenty hours of this — real samples, not
 * twenty sales, and nothing may generate them to trip the threshold.
 */
export async function sampledHours(slot: Slot): Promise<number> {
  return getDb().askSample.count({ where: { slot } });
}

/** The most recent successful run, for the observability #22 asks for. */
export async function lastSampledHour(): Promise<Date | null> {
  const latest = await getDb().askSample.findFirst({ orderBy: { hour: "desc" } });
  return latest?.hour ?? null;
}
