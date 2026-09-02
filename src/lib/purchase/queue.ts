import { Prisma } from "@prisma/client";

import { getDb } from "@/lib/db";
import { latestSampledAsk } from "@/lib/market/ask";
import {
  QUEUE_CAP_HOURS,
  SLOTS,
  type DurationHours,
  type Slot,
  surgeFromQueuedHours,
} from "@/lib/pricing";

/**
 * The queued-hours cap (#24).
 *
 * A hard ceiling on how long anyone can be made to wait for a slot.
 *
 * The cap is on hours rather than head count because hours are what a buyer
 * actually experiences: four people booking 24h each is a 96-hour queue, four
 * booking 1h each is a four-hour one. It is the same constant that drives surge
 * under decision D2, so a slot at the ceiling is also at 2.00x.
 *
 * ## The cap is on the wait, not on the queue
 *
 * A booking is refused when the wait a buyer would inherit already exceeds the
 * cap. That wait is the time left on the rental currently on the board plus
 * every queued hour ahead of them. Their own booking is not part of their own
 * wait, so it does not count against it.
 *
 * Both halves of that were learned rather than designed. Capping `queued + yours`
 * was tried first and makes the 24h duration unbuyable outright, since 0 + 24
 * exceeds the cap on an empty slot — "Own the day" is one of the five snap
 * points and the prototype's flagship booking.
 *
 * Then counting only queued hours turned out not to bound the wait at all: the
 * scenario harness produced a buyer waiting 19.4 hours against an 18-hour cap,
 * because the rental already on the board was invisible to the check. The worst
 * case was a fresh 24h rental plus a full queue — a 42-hour wait, which is
 * precisely the multi-day wait this cap exists to prevent.
 *
 * The consequence to know about: total queued hours can still reach CAP plus one
 * maximum duration, if someone books 24h when the cap's worth of wait was
 * already ahead of them. Nobody ever *joins* a wait longer than CAP — the last
 * of them joined at exactly CAP — but the slot then sits at its 2.00x ceiling
 * and refuses everyone until it drains back under.
 *
 * Beyond user experience this is a solvency question. An unbounded queue means
 * holding money for a slot that may be days away, which turns a rental into a
 * liability and compounds badly against a kill (#17) or a refund.
 */

/** Postgres raises this when it cannot serialise concurrent transactions. */
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";

/**
 * Sized for contention, not for a quiet laptop. CI runners routinely produce
 * "could not serialize access due to read/write dependencies" in bursts, and a
 * budget that runs out turns a recoverable conflict into a refused purchase on a
 * path that takes money.
 */
const MAX_SERIALIZATION_RETRIES = 8;
const RETRY_BASE_DELAY_MS = 20;

export class QueueAtCapacityError extends Error {
  constructor(
    readonly slot: Slot,
    readonly waitHours: number,
    readonly requestedHours: number,
  ) {
    super(
      `Slot ${slot} already carries a ${waitHours.toFixed(1)}h wait, past the ` +
        `${QUEUE_CAP_HOURS}h cap; it is not accepting bookings ` +
        `(a ${requestedHours}h booking was requested).`,
    );
    this.name = "QueueAtCapacityError";
  }
}

export type SlotCapacity = {
  slot: Slot;
  /** Hours queued behind the live rental. This is what drives surge. */
  queuedHours: number;
  /** Hours left on the rental currently on the board. Fractional. */
  liveRemainingHours: number;
  /** The wait a buyer joining now inherits: liveRemainingHours + queuedHours. */
  waitHours: number;
  /** How much longer that wait can grow before the slot closes. */
  remainingHours: number;
  /** Every duration, or none — the cap is on the wait, not on the booking. */
  availableDurations: DurationHours[];
  /**
   * The ask a buyer is quoted right now, in hundredths.
   *
   * The higher of what the queue justifies and what the slot's ask has decayed
   * to since its last peak — demand lifts the ask immediately, only time brings
   * it down.
   */
  multiplierCm: number;
  /** What the queue alone justifies, before decay is considered. */
  surgeFromQueueCm: number;
  atCapacity: boolean;
};

/**
 * Whether a slot will accept a new booking at all.
 *
 * Every duration is either available or none of them are: what is capped is the
 * wait a buyer inherits, which is the same whichever duration they pick.
 */
export function acceptsNewBookings(waitHours: number): boolean {
  return waitHours <= QUEUE_CAP_HOURS;
}

/**
 * How much longer the wait can grow before the slot closes.
 *
 * Not "how many hours will fit" — a slot with one hour of headroom still accepts
 * a 24h booking, because the cap is on the wait rather than on the queue.
 */
export function remainingCapacityHours(waitHours: number): number {
  return Math.max(0, QUEUE_CAP_HOURS - waitHours);
}

/**
 * Hours left on the rental currently on the board, or 0 when the slot is open.
 *
 * Liveness is derived from the window rather than from `status` (#1), so a
 * rental whose window has closed contributes nothing here even if nothing has
 * yet marked it ended.
 */
export async function liveRemainingHours(
  client: Prisma.TransactionClient,
  slot: Slot,
  now: Date,
): Promise<number> {
  const live = await client.purchase.findFirst({
    where: { slot, status: "live", startsAt: { lte: now }, endsAt: { gt: now } },
    select: { endsAt: true },
  });
  if (!live?.endsAt) return 0;
  return Math.max(0, (live.endsAt.getTime() - now.getTime()) / 3_600_000);
}

/** The full wait a buyer joining this slot right now would inherit, in hours. */
export async function waitHoursForSlot(
  client: Prisma.TransactionClient,
  slot: Slot,
  now: Date,
): Promise<number> {
  const [live, queued] = await Promise.all([
    liveRemainingHours(client, slot, now),
    queuedHoursForSlot(client, slot),
  ]);
  return live + queued;
}

/** Sums the hours queued on a slot. Killed and ended rows are not queued. */
export async function queuedHoursForSlot(
  client: Prisma.TransactionClient,
  slot: Slot,
): Promise<number> {
  const result = await client.purchase.aggregate({
    where: { slot, status: "queued" },
    _sum: { durationH: true },
  });
  return result._sum.durationH ?? 0;
}

export async function slotCapacity(
  client: Prisma.TransactionClient,
  slot: Slot,
  durations: readonly DurationHours[],
  now: Date = new Date(),
): Promise<SlotCapacity> {
  const [live, queuedHours, sampled] = await Promise.all([
    liveRemainingHours(client, slot, now),
    queuedHoursForSlot(client, slot),
    latestSampledAsk(client, slot),
  ]);
  const waitHours = live + queuedHours;
  const open = acceptsNewBookings(waitHours);

  // Surge prices demand, which is what is queued — not the tail of a rental
  // already paid for.
  const surgeFromQueueCm = surgeFromQueuedHours(queuedHours);

  return {
    slot,
    queuedHours,
    liveRemainingHours: live,
    waitHours,
    remainingHours: remainingCapacityHours(waitHours),
    availableDurations: open ? [...durations] : [],
    // A slot that surged and is still bleeding back toward base quotes the
    // decayed ask, not base. Without this the engine's decay would move the
    // chart while never affecting a price anybody pays.
    multiplierCm: Math.max(surgeFromQueueCm, sampled?.multiplierCm ?? 0),
    surgeFromQueueCm,
    atCapacity: !open,
  };
}

function isRetryableConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === SERIALIZATION_FAILURE ||
      error.code === DEADLOCK_DETECTED ||
      // Prisma maps some serialisation failures onto its own code.
      error.code === "P2034")
  );
}

/**
 * Runs `work` in a SERIALIZABLE transaction, retrying serialisation failures.
 *
 * The cap cannot be expressed as a check constraint — it is a sum across rows,
 * not a property of one. Two transactions at READ COMMITTED can both read 16
 * queued hours and both insert 3, leaving 22 against a cap of 18.
 *
 * SERIALIZABLE closes that: Postgres takes predicate locks over the rows the
 * sum read, sees the write-skew, and aborts one of the transactions. That is a
 * database guarantee rather than an application lock, and unlike an advisory
 * lock it needs no agreement between callers about which key to take.
 *
 * The cost is that a losing transaction must be retried, which is safe here
 * because the retry re-reads the queue and re-checks the cap.
 *
 * Retries back off with jitter. Retrying immediately means every transaction
 * that just collided collides again in lockstep, which turns a recoverable
 * conflict into a failure on a path that takes money.
 */
export async function inSerializableTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const db = getDb();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isRetryableConflict(error)) throw error;
      lastError = error;

      if (attempt < MAX_SERIALIZATION_RETRIES - 1) {
        const backoffMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
        // Full jitter: without it the losers of one collision retry together and
        // collide again in the same order.
        await sleep(Math.random() * backoffMs);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type NewPurchase = {
  slot: Slot;
  durationH: DurationHours;
  handle: string;
  platform: "github" | "youtube" | "instagram" | "tiktok" | "reddit" | "web";
  displayName?: string | null;
  targetUrl: string;
  tagline: string;
  priceHrCents: number;
  totalPaidCents: number;
  stripeSessionId?: string | null;
};

/**
 * Creates a queued purchase, refusing it if it would exceed the cap.
 *
 * The check and the insert are one serialisable transaction, because two buyers
 * can both see room and both commit. A check in the UI is advisory; a check
 * outside the transaction is a race.
 *
 * #26 calls this from the Stripe webhook and refunds on `QueueAtCapacityError`,
 * since taking money for a position that cannot exist is worse than a refund.
 */
export async function createQueuedPurchase(purchase: NewPurchase, now: Date = new Date()) {
  return inSerializableTransaction(async (tx) => {
    const wait = await waitHoursForSlot(tx, purchase.slot, now);

    if (!acceptsNewBookings(wait)) {
      throw new QueueAtCapacityError(purchase.slot, wait, purchase.durationH);
    }

    return tx.purchase.create({ data: { ...purchase, status: "queued" } });
  });
}

/**
 * The ask on every slot right now (#14).
 *
 * The same figure `slotCapacity` gives checkout, so the pricing dialog quotes
 * what a buyer would actually be charged rather than a second, prettier number
 * computed a different way. That includes decay: a slot bleeding back toward
 * base after a busy spell asks more than its queue alone would justify, and the
 * dialog has to say so or it is lying by omission.
 *
 * Read outside a transaction. These are three independent reads for display, and
 * serialising them would take locks that the page has no need of.
 */
export async function currentAsks(
  durations: readonly DurationHours[],
  now: Date = new Date(),
): Promise<SlotCapacity[]> {
  const db = getDb();
  return Promise.all(SLOTS.map((slot) => slotCapacity(db, slot, durations, now)));
}
