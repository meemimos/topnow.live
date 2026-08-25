import { Prisma } from "@prisma/client";

import { getDb } from "@/lib/db";
import {
  QUEUE_CAP_HOURS,
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
 * A booking is refused when the hours *already* queued exceed the cap. Your own
 * booking is not part of your own wait, so it does not count against it.
 *
 * The alternative — capping `queued + yours` — was tried first and makes the 24h
 * duration unbuyable outright, because 0 + 24 already exceeds an 18h cap. "Own
 * the day" is one of the five snap points and the prototype's flagship booking.
 *
 * The consequence to know about: total queued hours can reach CAP plus one
 * maximum duration, if someone books 24h when the cap's worth was already
 * queued. Nobody in that queue ever waited more than CAP to go live — the last
 * of them joined when CAP hours were queued — but the slot then sits at its
 * 2.00x ceiling and refuses everyone until it drains back under the cap.
 *
 * Beyond user experience this is a solvency question. An unbounded queue means
 * holding money for a slot that may be days away, which turns a rental into a
 * liability and compounds badly against a kill (#17) or a refund.
 */

/** Postgres raises this when it cannot serialise concurrent transactions. */
const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_DETECTED = "40P01";

const MAX_SERIALIZATION_RETRIES = 5;

export class QueueAtCapacityError extends Error {
  constructor(
    readonly slot: Slot,
    readonly queuedHours: number,
    readonly requestedHours: number,
  ) {
    super(
      `Slot ${slot} already has ${queuedHours}h queued, past the ${QUEUE_CAP_HOURS}h wait cap; ` +
        `it is not accepting bookings (a ${requestedHours}h booking was requested).`,
    );
    this.name = "QueueAtCapacityError";
  }
}

export type SlotCapacity = {
  slot: Slot;
  /** Hours already queued. Excludes the live rental — that is a separate thing. */
  queuedHours: number;
  /** How much longer the queue can grow before the slot closes to new bookings. */
  remainingHours: number;
  /** Every duration, or none — the cap is on the wait, not on the booking. */
  availableDurations: DurationHours[];
  /** The wait a buyer joining now inherits, in hours. Excludes the live rental. */
  waitHours: number;
  /** Surge implied by the current queue, in hundredths. */
  multiplierCm: number;
  atCapacity: boolean;
};

/**
 * Whether a slot will accept a new booking at all.
 *
 * Every duration is either available or none of them are: what is being capped
 * is the wait a buyer inherits, which is the same whichever duration they pick.
 */
export function acceptsNewBookings(queuedHours: number): boolean {
  return queuedHours <= QUEUE_CAP_HOURS;
}

/**
 * How much longer the queue can grow before the slot closes.
 *
 * Not "how many hours will fit" — a slot with 1 hour of headroom still accepts
 * a 24h booking, because the cap is on the wait rather than on the queue.
 */
export function remainingCapacityHours(queuedHours: number): number {
  return Math.max(0, QUEUE_CAP_HOURS - queuedHours);
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
): Promise<SlotCapacity> {
  const queuedHours = await queuedHoursForSlot(client, slot);
  const open = acceptsNewBookings(queuedHours);

  return {
    slot,
    queuedHours,
    waitHours: queuedHours,
    remainingHours: remainingCapacityHours(queuedHours),
    availableDurations: open ? [...durations] : [],
    multiplierCm: surgeFromQueuedHours(queuedHours),
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
    }
  }

  throw lastError;
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
export async function createQueuedPurchase(purchase: NewPurchase) {
  return inSerializableTransaction(async (tx) => {
    const queuedHours = await queuedHoursForSlot(tx, purchase.slot);

    if (!acceptsNewBookings(queuedHours)) {
      throw new QueueAtCapacityError(purchase.slot, queuedHours, purchase.durationH);
    }

    return tx.purchase.create({ data: { ...purchase, status: "queued" } });
  });
}
