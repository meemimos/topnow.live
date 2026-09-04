import type { Platform, Purchase } from "@prisma/client";

import { displayNameFor } from "@/components/board/platform";
import { multiplierFromAsk, SLOTS, type Slot } from "@/lib/pricing";
import { estimateQueue } from "@/lib/time";

/**
 * The ledger (#11) — one row per purchase.
 *
 * A queue entry and a completed sale are the *same record* at different points
 * in its life, and this is the surface where that becomes visible. So it is one
 * query over one table, partitioned into three sections in memory. Three fetches
 * would not only cost more, they could disagree: a rental promoted between the
 * live query and the queued one would appear in both sections, or in neither.
 *
 * ## The order reverses between sections, deliberately
 *
 *   IN THE QUEUE   boughtAt ascending  — the oldest purchase goes live next
 *   ENDED          boughtAt descending — a tape reads newest first
 *
 * Both are correct and they point opposite ways, which is exactly why the
 * section headers carry copy explaining it. An unexplained reversal in one table
 * reads as a sorting bug.
 *
 * ## Liveness is still derived
 *
 * The live section is not `status = 'live'`. It is `status = 'live'` **and** the
 * window contains `now`, the same rule the board uses (#1). A rental whose window
 * has closed has ended, whether or not anything has yet written that down — so it
 * belongs under ENDED here even while its column still says live.
 *
 * ## Pure on purpose
 *
 * Nothing here touches the database. The ledger table is a client component — it
 * owns the slot filter — so it imports these types and `filterLedger`, and an
 * import of the Prisma client anywhere in this file would follow them into the
 * browser bundle. The query itself lives in `state.ts` with the other reads.
 */

/** Killed rows are terminal, so they read as part of the tape rather than vanishing. */
export type LedgerSection = "live" | "queued" | "ended";

export type LedgerRow = {
  id: string;
  slot: Slot;
  section: LedgerSection;
  /** `@handle`, or a website's display name. Rendered as untrusted text. */
  name: string;
  platform: Platform;
  durationH: number;
  /** The locked ask. Never re-derived from the current queue. */
  askHrCents: number;
  /** Recovered from the locked ask, so the ledger prints the rate actually paid. */
  multiplierCm: number;
  totalPaidCents: number;
  boughtAtMs: number;
  /** Live rows only: when the window closes, for the running clock. */
  endsAtMs: number | null;
  /** Queued rows only: the estimated go-live, which is why it prints with a `~`. */
  estimatedStartMs: number | null;
  /** Ended rows only: when it actually ended, or when it was killed. */
  endedAtMs: number | null;
  /** Killed listings stay in the tape (#17); the badge says so. */
  killed: boolean;
};

export type Ledger = {
  live: LedgerRow[];
  queued: LedgerRow[];
  ended: LedgerRow[];
  /** Every purchase the ledger knows about, across all three sections. */
  total: number;
};

/** Whether a row's window actually contains `now`, regardless of what `status` says. */
function isOnBoard(purchase: Purchase, now: Date): boolean {
  if (purchase.status !== "live" || !purchase.startsAt || !purchase.endsAt) return false;
  return purchase.startsAt <= now && purchase.endsAt > now;
}

function baseRow(purchase: Purchase, section: LedgerSection): LedgerRow {
  const slot = purchase.slot as Slot;
  return {
    id: purchase.id,
    slot,
    section,
    name: displayNameFor(purchase),
    platform: purchase.platform,
    durationH: purchase.durationH,
    askHrCents: purchase.priceHrCents,
    multiplierCm: multiplierFromAsk(slot, purchase.priceHrCents),
    totalPaidCents: purchase.totalPaidCents,
    boughtAtMs: purchase.boughtAt.getTime(),
    endsAtMs: null,
    estimatedStartMs: null,
    endedAtMs: null,
    killed: purchase.status === "killed",
  };
}

/**
 * Partitions one ordered read into the three sections.
 *
 * `rows` arrives ascending by `boughtAt`, which is already the queue's order; the
 * tape is reversed here. That is one index scan rather than two, and it keeps the
 * reversal in the code that also names it.
 */
export function buildLedger(rows: readonly Purchase[], now: Date = new Date()): Ledger {
  const live: LedgerRow[] = [];
  const ended: LedgerRow[] = [];
  // Kept per slot: a go-live estimate depends on everything queued ahead of it
  // *on that slot*, so the queue cannot be estimated as one flat list.
  const queuedBySlot = new Map<Slot, Purchase[]>();

  for (const purchase of rows) {
    if (isOnBoard(purchase, now)) {
      live.push({ ...baseRow(purchase, "live"), endsAtMs: purchase.endsAt!.getTime() });
      continue;
    }

    if (purchase.status === "queued") {
      const slot = purchase.slot as Slot;
      const forSlot = queuedBySlot.get(slot) ?? [];
      forSlot.push(purchase);
      queuedBySlot.set(slot, forSlot);
      continue;
    }

    // Everything else is terminal: ended, killed, or a live row whose window has
    // closed and which nothing has marked ended yet.
    ended.push({
      ...baseRow(purchase, "ended"),
      endedAtMs: (purchase.killedAt ?? purchase.endsAt)?.getTime() ?? null,
    });
  }

  const queued: LedgerRow[] = [];
  for (const slot of SLOTS) {
    const forSlot = queuedBySlot.get(slot);
    if (!forSlot) continue;

    // Each estimate starts when the one before it ends, so they are computed for
    // the slot's queue as a whole rather than per row — otherwise neighbouring
    // rows would print times that contradict each other.
    const liveOnSlot = live.find((row) => row.slot === slot);
    const liveEndsAt = liveOnSlot?.endsAtMs ? new Date(liveOnSlot.endsAtMs) : null;
    const estimates = estimateQueue(now, forSlot, liveEndsAt);

    forSlot.forEach((purchase, index) => {
      queued.push({
        ...baseRow(purchase, "queued"),
        estimatedStartMs: estimates[index]!.startsAt.getTime(),
      });
    });
  }

  return {
    live,
    // Oldest first, across slots. Within a slot this is already the promotion
    // order; across slots it is the order the purchases were made.
    queued: queued.sort((a, b) => a.boughtAtMs - b.boughtAtMs),
    // The tape reads newest first.
    ended: ended.reverse(),
    total: rows.length,
  };
}

/** Narrows a ledger to one slot, or returns it unchanged for `all`. */
export function filterLedger(ledger: Ledger, slot: Slot | "all"): Ledger {
  if (slot === "all") return ledger;

  const keep = (rows: LedgerRow[]) => rows.filter((row) => row.slot === slot);
  const live = keep(ledger.live);
  const queued = keep(ledger.queued);
  const ended = keep(ledger.ended);

  return { live, queued, ended, total: live.length + queued.length + ended.length };
}
