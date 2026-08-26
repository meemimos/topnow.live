import { Prisma, type Purchase, type PurchaseStatus } from "@prisma/client";

import { getDb } from "@/lib/db";
import { SLOTS, type Slot } from "@/lib/pricing";

import { inSerializableTransaction } from "./queue";

/**
 * The slot state machine (#1).
 *
 *     queued --promotion--> live --expiry--> ended
 *        \                    \
 *         `----- killed -------'   (admin, #17)
 *
 * ## Liveness is derived, not written
 *
 * The build prompt invited pushback on using a scheduled job for expiry, and
 * this module takes it. A cron that flips `live -> ended` makes correctness a
 * function of whether the cron ran: restart it, deploy during a tick, miss a
 * minute, and the board lies about who is on it.
 *
 * So nothing here treats `status` as the authority for whether a rental is live.
 * The authority is the window: a row is on the board when
 * `startsAt <= now < endsAt`. A rental that should have ended has ended, because
 * the query says so, whether or not any process was awake to notice. `status` is
 * a materialised convenience for indexing and for the ledger's three sections,
 * and where the two disagree the timestamps win.
 *
 * Expiry therefore costs nothing and cannot be missed. That leaves promotion as
 * the only genuine write.
 *
 * ## Promotion
 *
 * Promotion runs on read (`currentBoard`), so a slot frees up and refills
 * without anything having observed the expiry. #22's job calls the same code —
 * purely so a slot that frees at 3am does not wait for the next visitor. If that
 * job never runs, the board is still correct.
 *
 * Safety comes from the partial unique index in #21:
 *
 *     CREATE UNIQUE INDEX purchase_one_live_per_slot
 *       ON purchase (slot) WHERE status = 'live';
 *
 * At most one live row per slot, at any instant, however many transactions race.
 * The loser of a race gets a unique violation and is retried, not a corrupted
 * board.
 */

/** Rows whose `status` is live but whose window has closed. */
function expiredWhere(slot: Slot | undefined, now: Date): Prisma.PurchaseWhereInput {
  return { ...(slot ? { slot } : {}), status: "live", endsAt: { lte: now } };
}

/** Rows genuinely on the board: status live *and* the window contains now. */
function onBoardWhere(slot: Slot | undefined, now: Date): Prisma.PurchaseWhereInput {
  return {
    ...(slot ? { slot } : {}),
    status: "live",
    startsAt: { lte: now },
    endsAt: { gt: now },
  };
}

/**
 * Materialises expiry for a slot, then promotes the oldest queued purchase if
 * the slot is free. Returns the promoted row, or null if there was nothing to do.
 *
 * Both steps are in one transaction because the partial unique index is on
 * `status = 'live'` — a stale live row whose window has closed still occupies
 * the index and would block the promotion behind it.
 */
async function promoteWithin(
  tx: Prisma.TransactionClient,
  slot: Slot,
  now: Date,
): Promise<Purchase | null> {
  // Retire anything whose window has closed. This is bookkeeping catching up
  // with a fact the timestamps already established.
  await tx.purchase.updateMany({
    where: expiredWhere(slot, now),
    data: { status: "ended" },
  });

  const occupied = await tx.purchase.findFirst({
    where: { slot, status: "live" },
    select: { id: true },
  });
  if (occupied) return null;

  const next = await tx.purchase.findFirst({
    where: { slot, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
  if (!next) return null;

  // boughtAt is stamped by the database (CURRENT_TIMESTAMP) while `now` comes
  // from the application clock. If the app server runs even slightly behind the
  // database, a rental promoted moments after purchase would start before it was
  // bought, and purchase_starts_after_bought (#21) would reject the update. The
  // clamp makes promotion independent of skew between the two clocks.
  const startsAt = now > next.boughtAt ? now : next.boughtAt;
  const endsAt = new Date(startsAt.getTime() + next.durationH * 3_600_000);

  // Guarded on `status: "queued"` so that if another transaction promoted this
  // same row first, this updates nothing rather than overwriting its window.
  const claimed = await tx.purchase.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "live", startsAt, endsAt },
  });
  if (claimed.count === 0) return null;

  return { ...next, status: "live", startsAt, endsAt };
}

/** Postgres raises this when two transactions both try to hold one slot. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Promotes one slot, tolerating a lost race.
 *
 * Losing means another transaction promoted into this slot first, which is a
 * correct outcome — the slot is filled either way — so there is nothing to
 * retry and nothing to report.
 */
export async function promoteSlot(slot: Slot, now: Date = new Date()): Promise<Purchase | null> {
  try {
    return await inSerializableTransaction((tx) => promoteWithin(tx, slot, now));
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/** Whether a slot has anything to do: a closed window, or a free slot with a queue. */
async function needsPromotion(slot: Slot, now: Date): Promise<boolean> {
  const db = getDb();

  const expired = await db.purchase.count({ where: expiredWhere(slot, now) });
  if (expired > 0) return true;

  const live = await db.purchase.count({ where: onBoardWhere(slot, now) });
  if (live > 0) return false;

  const queued = await db.purchase.count({ where: { slot, status: "queued" } });
  return queued > 0;
}

/**
 * Brings every slot up to date.
 *
 * Called before a board read, and by #22's job. Opens no transaction when there
 * is nothing to promote, so an idle board costs three counts rather than three
 * serialisable writes.
 */
export async function promoteAll(now: Date = new Date()): Promise<Purchase[]> {
  const promoted: Purchase[] = [];

  for (const slot of SLOTS) {
    if (!(await needsPromotion(slot, now))) continue;
    const row = await promoteSlot(slot, now);
    if (row) promoted.push(row);
  }

  return promoted;
}

export type BoardSlot = {
  slot: Slot;
  /** The rental on the board now, or null when the slot is open. */
  live: Purchase | null;
  /** Hours queued behind it. Drives surge (#2) and the wait cap (#24). */
  queuedHours: number;
  queuedCount: number;
};

/**
 * The board: `status = live`, filtered to rentals whose window contains `now`.
 *
 * Promotes first, so a slot that expired while nothing was watching is refilled
 * rather than shown as spuriously empty. The read itself would be correct
 * without that — an expired rental is already excluded by its window — but the
 * queue behind it would sit unpromoted until something else ran.
 */
export async function currentBoard(now: Date = new Date()): Promise<BoardSlot[]> {
  // Promotion is an optimisation on this path, not a precondition: the read
  // below consults only the window, so it is correct whether or not this
  // succeeded. Under heavy contention a serialisable transaction can exhaust its
  // retry budget, and failing the whole board read for that would take the site
  // down over a write that #22's job will redo within the hour.
  try {
    await promoteAll(now);
  } catch (error) {
    console.error("[board] promotion failed; serving the board without it", error);
  }

  const db = getDb();

  const live = await db.purchase.findMany({ where: onBoardWhere(undefined, now) });
  const queued = await db.purchase.groupBy({
    by: ["slot"],
    where: { status: "queued" },
    _sum: { durationH: true },
    _count: { _all: true },
  });

  return SLOTS.map((slot) => {
    const queue = queued.find((row) => row.slot === slot);
    return {
      slot,
      live: live.find((row) => row.slot === slot) ?? null,
      queuedHours: queue?._sum.durationH ?? 0,
      queuedCount: queue?._count._all ?? 0,
    };
  });
}

/**
 * A single slot's board state, without promoting anything.
 *
 * This is the read that proves the derived-liveness claim: it consults only the
 * window, so it is correct with no scheduler and no promotion having run.
 */
export async function liveOnSlot(slot: Slot, now: Date = new Date()): Promise<Purchase | null> {
  const db = getDb();
  return db.purchase.findFirst({ where: onBoardWhere(slot, now) });
}

/** The queue for a slot: oldest purchase first — earliest bought goes live soonest. */
export async function queueForSlot(slot: Slot): Promise<Purchase[]> {
  return getDb().purchase.findMany({
    where: { slot, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
}

/** The tape: ended purchases, most recent first. */
export async function tape(limit = 50): Promise<Purchase[]> {
  return getDb().purchase.findMany({
    where: { status: "ended" },
    orderBy: { boughtAt: "desc" },
    take: limit,
  });
}

/**
 * Kills a listing (#17).
 *
 * Killing the live rental frees the slot and promotes the next queued purchase
 * in the same transaction, so nobody sees a slot that is briefly nobody's. The
 * row stays in the ledger marked killed — the tape is a record and does not get
 * rewritten.
 */
export class NotKillableError extends Error {
  constructor(
    readonly id: string,
    readonly status: PurchaseStatus,
  ) {
    super(`Purchase ${id} is ${status} and cannot be killed.`);
    this.name = "NotKillableError";
  }
}

export async function killPurchase(
  id: string,
  reason: string,
  now: Date = new Date(),
): Promise<{ killed: Purchase; promoted: Purchase | null }> {
  return inSerializableTransaction(async (tx) => {
    const target = await tx.purchase.findUniqueOrThrow({ where: { id } });

    // Only a listing that is queued or on the board can be taken down. Killing
    // an ended rental would quietly remove it from the tape — the tape is a
    // record and does not get rewritten — and killing an already-killed one
    // would overwrite the audit trail's timestamp and reason on a double click.
    if (target.status !== "queued" && target.status !== "live") {
      throw new NotKillableError(id, target.status);
    }

    const killed = await tx.purchase.update({
      where: { id },
      data: { status: "killed", killedAt: now, killedReason: reason },
    });

    // Only a live kill leaves a hole to fill. Killing from the queue just frees
    // its hours, which the next capacity check picks up on its own.
    const promoted =
      target.status === "live" ? await promoteWithin(tx, target.slot as Slot, now) : null;

    return { killed, promoted };
  });
}
