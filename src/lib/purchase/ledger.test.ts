import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { BASE_MULTIPLIER_CM, quoteForQueue, type DurationHours, type Slot } from "@/lib/pricing";

import { filterLedger } from "./ledger";
import { readLedger } from "./state";

const db = getDb();
const HOUR = 3_600_000;

/** A fixed clock, so every window in these tests is exact rather than approximate. */
const NOW = new Date("2026-08-25T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
  const slot = (overrides.slot as Slot) ?? 1;
  const durationH = (overrides.durationH as DurationHours) ?? 3;
  const q = quoteForQueue(slot, durationH, 0);
  return {
    slot,
    durationH,
    handle: "mira_builds",
    platform: "github" as const,
    targetUrl: "https://github.com/mira_builds",
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
    priceHrCents: q.askHrCents,
    totalPaidCents: q.totalCents,
    ...overrides,
  };
}

async function queue(slot: Slot, durationH: DurationHours, minutesAgo: number, handle: string) {
  return db.purchase.create({
    data: row({ slot, durationH, handle, boughtAt: new Date(NOW.getTime() - minutesAgo * 60_000) }),
  });
}

async function live(slot: Slot, durationH: DurationHours, startsAt: Date, handle: string) {
  return db.purchase.create({
    data: row({
      slot,
      durationH,
      handle,
      status: "live" as const,
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * HOUR),
    }),
  });
}

async function ended(slot: Slot, durationH: DurationHours, endedAt: Date, handle: string) {
  const startsAt = new Date(endedAt.getTime() - durationH * HOUR);
  return db.purchase.create({
    data: row({
      slot,
      durationH,
      handle,
      status: "ended" as const,
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: endedAt,
    }),
  });
}

beforeEach(async () => {
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.purchase.deleteMany();
  await db.$disconnect();
});

describe("one query, three sections", () => {
  it("partitions live, queued and ended out of a single read", async () => {
    await live(1, 6, new Date(NOW.getTime() - 2 * HOUR), "on_board");
    await queue(1, 3, 30, "waiting");
    await ended(2, 1, new Date(NOW.getTime() - 5 * HOUR), "finished");

    const ledger = await readLedger(NOW);

    expect(ledger.live.map((r) => r.name)).toEqual(["@on_board"]);
    expect(ledger.queued.map((r) => r.name)).toEqual(["@waiting"]);
    expect(ledger.ended.map((r) => r.name)).toEqual(["@finished"]);
    expect(ledger.total).toBe(3);
  });

  it("counts every section in the total", async () => {
    await live(1, 6, new Date(NOW.getTime() - 1 * HOUR), "one");
    await queue(1, 3, 30, "two");
    await queue(1, 3, 20, "three");
    await ended(3, 1, new Date(NOW.getTime() - 9 * HOUR), "four");

    expect((await readLedger(NOW)).total).toBe(4);
  });
});

describe("liveness is derived here too", () => {
  /**
   * The ledger must not trust `status` any more than the board does. A rental
   * whose window closed belongs under ENDED even while its column still says
   * live and nothing has run to correct it.
   */
  it("files a stale live row under ended, and does not write to it", async () => {
    await live(1, 3, new Date(NOW.getTime() - 5 * HOUR), "expired");

    const ledger = await readLedger(NOW);
    expect(ledger.live).toHaveLength(0);
    expect(ledger.ended.map((r) => r.name)).toEqual(["@expired"]);

    const stored = await db.purchase.findFirstOrThrow({ where: { handle: "expired" } });
    expect(stored.status).toBe("live");
  });

  it("excludes a live row whose window has not opened yet", async () => {
    await live(1, 3, new Date(NOW.getTime() + 1 * HOUR), "not_yet");

    const ledger = await readLedger(NOW);
    expect(ledger.live).toHaveLength(0);
  });
});

describe("the order reverses between queue and tape", () => {
  it("orders the queue oldest first — the earliest bought goes live soonest", async () => {
    await queue(1, 1, 90, "first_in");
    await queue(1, 1, 60, "second_in");
    await queue(1, 1, 30, "third_in");

    const ledger = await readLedger(NOW);
    expect(ledger.queued.map((r) => r.name)).toEqual(["@first_in", "@second_in", "@third_in"]);
  });

  it("orders the tape newest first", async () => {
    await ended(1, 1, new Date(NOW.getTime() - 9 * HOUR), "oldest");
    await ended(1, 1, new Date(NOW.getTime() - 5 * HOUR), "middle");
    await ended(1, 1, new Date(NOW.getTime() - 2 * HOUR), "newest");

    const ledger = await readLedger(NOW);
    expect(ledger.ended.map((r) => r.name)).toEqual(["@newest", "@middle", "@oldest"]);
  });
});

describe("go-live estimates", () => {
  /**
   * Each estimate has to start where the one before it ends. Computed per row in
   * isolation, neighbouring rows would print times that contradict each other.
   */
  it("chains estimates so each starts when the one before it ends", async () => {
    await live(1, 6, new Date(NOW.getTime() - 2 * HOUR), "on_board");
    await queue(1, 3, 40, "next_up");
    await queue(1, 1, 20, "after_that");

    const ledger = await readLedger(NOW);
    const [first, second] = ledger.queued;

    // Four hours left on the live rental.
    expect(first!.estimatedStartMs).toBe(NOW.getTime() + 4 * HOUR);
    // Plus the three hours the row ahead of it booked.
    expect(second!.estimatedStartMs).toBe(NOW.getTime() + 7 * HOUR);
  });

  it("estimates from now when the slot is free", async () => {
    await queue(2, 3, 15, "straight_on");

    const ledger = await readLedger(NOW);
    expect(ledger.queued[0]!.estimatedStartMs).toBe(NOW.getTime());
  });

  /** Slot 2's queue must not be pushed back by slot 1's live rental. */
  it("keeps each slot's queue independent", async () => {
    await live(1, 12, new Date(NOW.getTime() - 1 * HOUR), "long_one");
    await queue(1, 1, 30, "behind_it");
    await queue(2, 1, 30, "other_slot");

    const ledger = await readLedger(NOW);
    const byName = new Map(ledger.queued.map((r) => [r.name, r]));

    expect(byName.get("@behind_it")!.estimatedStartMs).toBe(NOW.getTime() + 11 * HOUR);
    expect(byName.get("@other_slot")!.estimatedStartMs).toBe(NOW.getTime());
  });
});

describe("killed listings", () => {
  /** A kill does not rewrite the tape — the row stays, and says what happened. */
  it("keeps a killed row in the tape, flagged", async () => {
    const killedAt = new Date(NOW.getTime() - 30 * 60_000);
    await db.purchase.create({
      data: row({
        slot: 1,
        handle: "taken_down",
        status: "killed" as const,
        boughtAt: new Date(NOW.getTime() - 2 * HOUR),
        killedAt,
        killedReason: "Impersonation.",
      }),
    });

    const ledger = await readLedger(NOW);
    expect(ledger.ended).toHaveLength(1);
    expect(ledger.ended[0]!.killed).toBe(true);
    expect(ledger.ended[0]!.endedAtMs).toBe(killedAt.getTime());
  });
});

describe("the rate is the one that was paid", () => {
  /**
   * A purchase stores its ask but not the multiplier behind it. Recovering it has
   * to be exact, or the ledger prints a rate that does not multiply out to what
   * the buyer was actually charged.
   */
  it("recovers the locked multiplier exactly", async () => {
    // 12 queued hours against a 24h cap is 1.50x.
    const quote = quoteForQueue(1, 3, 12);
    await db.purchase.create({
      data: row({
        slot: 1,
        durationH: 3,
        handle: "surged",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        boughtAt: new Date(NOW.getTime() - HOUR),
      }),
    });

    const ledger = await readLedger(NOW);
    expect(ledger.queued[0]!.multiplierCm).toBe(quote.multiplierCm);
    expect(ledger.queued[0]!.askHrCents).toBe(quote.askHrCents);
  });

  it("reads base as exactly 1.00x", async () => {
    await queue(3, 1, 10, "at_base");
    const ledger = await readLedger(NOW);
    expect(ledger.queued[0]!.multiplierCm).toBe(BASE_MULTIPLIER_CM);
  });
});

describe("the slot filter", () => {
  it("applies across all three sections at once", async () => {
    await live(1, 6, new Date(NOW.getTime() - 1 * HOUR), "live_one");
    await live(2, 6, new Date(NOW.getTime() - 1 * HOUR), "live_two");
    await queue(1, 1, 30, "queued_one");
    await queue(2, 1, 30, "queued_two");
    await ended(1, 1, new Date(NOW.getTime() - 8 * HOUR), "ended_one");
    await ended(2, 1, new Date(NOW.getTime() - 8 * HOUR), "ended_two");

    const only1 = filterLedger(await readLedger(NOW), 1);

    expect(only1.live.map((r) => r.name)).toEqual(["@live_one"]);
    expect(only1.queued.map((r) => r.name)).toEqual(["@queued_one"]);
    expect(only1.ended.map((r) => r.name)).toEqual(["@ended_one"]);
    expect(only1.total).toBe(3);
  });

  it("returns the ledger unchanged for all", async () => {
    await queue(1, 1, 30, "one");
    await queue(2, 1, 20, "two");

    const ledger = await readLedger(NOW);
    expect(filterLedger(ledger, "all")).toBe(ledger);
  });
});

describe("empty and single-row states", () => {
  it("reads an empty ledger as empty, inventing nothing", async () => {
    const ledger = await readLedger(NOW);
    expect(ledger).toMatchObject({ live: [], queued: [], ended: [], total: 0 });
  });

  it("reads a ledger holding exactly one purchase", async () => {
    await queue(1, 1, 5, "only_one");

    const ledger = await readLedger(NOW);
    expect(ledger.total).toBe(1);
    expect(ledger.queued).toHaveLength(1);
    expect(ledger.live).toHaveLength(0);
    expect(ledger.ended).toHaveLength(0);
  });
});

describe("websites", () => {
  it("shows a display name rather than an @handle", async () => {
    await db.purchase.create({
      data: row({
        slot: 1,
        handle: "ledgerless.dev",
        platform: "web" as const,
        displayName: "Ledgerless",
        targetUrl: "https://ledgerless.dev",
        boughtAt: new Date(NOW.getTime() - HOUR),
      }),
    });

    const ledger = await readLedger(NOW);
    expect(ledger.queued[0]!.name).toBe("Ledgerless");
  });
});
