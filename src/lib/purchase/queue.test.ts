import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { DURATION_HOURS, QUEUE_CAP_HOURS, quoteForQueue } from "@/lib/pricing";

import {
  QueueAtCapacityError,
  acceptsNewBookings,
  createQueuedPurchase,
  liveRemainingHours,
  queuedHoursForSlot,
  remainingCapacityHours,
  slotCapacity,
  waitHoursForSlot,
  type NewPurchase,
} from "./queue";

const db = getDb();
const HOUR = 3_600_000;
const NOW = new Date("2026-09-01T12:00:00.000Z");

/** Puts a live rental on `slot` with `hoursLeft` still to run at NOW. */
async function seedLive(slot: 1 | 2 | 3, durationH: 1 | 3 | 6 | 12 | 24, hoursLeft: number) {
  const startsAt = new Date(NOW.getTime() - (durationH - hoursLeft) * HOUR);
  const q = quoteForQueue(slot, durationH, 0);
  return db.purchase.create({
    data: {
      ...newPurchase({ slot, durationH, handle: `live_${slot}` }),
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
      status: "live",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * HOUR),
    },
  });
}

function newPurchase(overrides: Partial<NewPurchase> = {}): NewPurchase {
  const slot = overrides.slot ?? 1;
  const durationH = overrides.durationH ?? 3;
  const q = quoteForQueue(slot, durationH, 0);
  return {
    slot,
    durationH,
    handle: "mira_builds",
    platform: "github",
    targetUrl: "https://github.com/mira_builds",
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
    priceHrCents: q.askHrCents,
    totalPaidCents: q.totalCents,
    ...overrides,
  };
}

/** Fills a slot's queue to exactly `hours`, bypassing the cap check. */
async function seedQueue(slot: 1 | 2 | 3, hours: number) {
  let remaining = hours;
  let index = 0;
  while (remaining > 0) {
    const durationH = ([12, 6, 3, 1] as const).find((h) => h <= remaining) ?? 1;
    const q = quoteForQueue(slot, durationH, 0);
    await db.purchase.create({
      data: {
        ...newPurchase({ slot, durationH, handle: `seed_${slot}_${index}` }),
        priceHrCents: q.askHrCents,
        totalPaidCents: q.totalCents,
        status: "queued",
      },
    });
    remaining -= durationH;
    index += 1;
  }
}

beforeEach(async () => {
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.purchase.deleteMany();
  await db.$disconnect();
});

describe("acceptsNewBookings", () => {
  // The cap is on the wait a buyer inherits, not on the queue. Their own booking
  // is not part of their own wait, so a slot with an hour of headroom still
  // takes a 24h booking.
  it("accepts any duration while the wait is under the cap", () => {
    expect(acceptsNewBookings(23)).toBe(true);
    expect(acceptsNewBookings(QUEUE_CAP_HOURS)).toBe(true);
  });

  it("closes once the wait is past the cap", () => {
    expect(acceptsNewBookings(QUEUE_CAP_HOURS + 0.1)).toBe(false);
  });

  // Capping queued + requested instead would make this permanently unbuyable,
  // since 0 + 24 already exceeds the cap on an empty slot.
  it("keeps the 24h booking buyable on an empty slot", () => {
    expect(acceptsNewBookings(0)).toBe(true);
    expect(DURATION_HOURS).toContain(24);
  });

  it("reports how much longer the wait can grow, floored at zero", () => {
    expect(remainingCapacityHours(0)).toBe(QUEUE_CAP_HOURS);
    expect(remainingCapacityHours(18)).toBe(6);
    expect(remainingCapacityHours(QUEUE_CAP_HOURS)).toBe(0);
    expect(remainingCapacityHours(QUEUE_CAP_HOURS + 99)).toBe(0);
  });
});

describe("the wait includes the rental already on the board", () => {
  /**
   * The bug the scenario harness found. Counting only queued hours let a buyer
   * inherit a 19.4h wait against an 18h cap, because the rental on the board was
   * invisible to the check. Worst case was a fresh 24h rental plus a full queue:
   * a 42-hour wait, which is what this cap exists to prevent.
   */
  it("counts the live rental's remaining time", async () => {
    await seedLive(1, 12, 8);
    await seedQueue(1, 6);

    expect(await liveRemainingHours(db, 1, NOW)).toBeCloseTo(8, 5);
    expect(await queuedHoursForSlot(db, 1)).toBe(6);
    expect(await waitHoursForSlot(db, 1, NOW)).toBeCloseTo(14, 5);
  });

  it("ignores a rental whose window has closed, even if nothing marked it ended", async () => {
    await seedLive(1, 3, -2); // ended two hours ago
    expect(await liveRemainingHours(db, 1, NOW)).toBe(0);
  });

  it("refuses a booking the live rental alone pushes past the cap", async () => {
    await seedLive(1, 24, 20);
    await seedQueue(1, 6); // 20 + 6 = 26h wait, past the 24h cap

    await expect(createQueuedPurchase(newPurchase({ slot: 1, durationH: 1 }), NOW)).rejects.toThrow(
      QueueAtCapacityError,
    );
  });

  it("still accepts a booking behind a fresh 24h rental", async () => {
    await seedLive(1, 24, 24);
    await expect(
      createQueuedPurchase(newPurchase({ slot: 1, durationH: 3 }), NOW),
    ).resolves.toBeTruthy();
  });

  /** The scenario that produced the 19.4h wait, now bounded. */
  it("never admits anyone to a wait longer than the cap, live rental included", async () => {
    await seedLive(1, 6, 4);
    const waitsAtJoin: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      const before = await waitHoursForSlot(db, 1, NOW);
      try {
        await createQueuedPurchase(
          newPurchase({ slot: 1, durationH: 3, handle: `drip_${i}` }),
          NOW,
        );
        waitsAtJoin.push(before);
      } catch (error) {
        expect(error).toBeInstanceOf(QueueAtCapacityError);
      }
    }

    expect(waitsAtJoin.length).toBeGreaterThan(0);
    for (const wait of waitsAtJoin) {
      expect(wait).toBeLessThanOrEqual(QUEUE_CAP_HOURS);
    }
  });
});

describe("queued hours", () => {
  it("sums only queued rows on that slot", async () => {
    await seedQueue(1, 6);
    await seedQueue(2, 3);
    expect(await queuedHoursForSlot(db, 1)).toBe(6);
    expect(await queuedHoursForSlot(db, 2)).toBe(3);
    expect(await queuedHoursForSlot(db, 3)).toBe(0);
  });

  // The cap counts queued hours only. What is on the board now is a separate
  // thing and is shown separately.
  it("excludes the live rental", async () => {
    const boughtAt = new Date(Date.now() - 60 * 60_000);
    const startsAt = new Date(boughtAt.getTime() + 30 * 60_000);
    await db.purchase.create({
      data: {
        ...newPurchase({ slot: 1, durationH: 6, handle: "live_one" }),
        status: "live",
        boughtAt,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
      },
    });
    await seedQueue(1, 3);

    expect(await queuedHoursForSlot(db, 1)).toBe(3);
  });

  // #17: killing a queued entry frees its hours immediately and reopens the slot.
  it("frees hours the moment a queued entry is killed", async () => {
    await seedQueue(1, QUEUE_CAP_HOURS);
    expect(await queuedHoursForSlot(db, 1)).toBe(QUEUE_CAP_HOURS);

    const victim = await db.purchase.findFirstOrThrow({ where: { slot: 1, status: "queued" } });
    await db.purchase.update({
      where: { id: victim.id },
      data: { status: "killed", killedAt: new Date(), killedReason: "impersonation" },
    });

    expect(await queuedHoursForSlot(db, 1)).toBe(QUEUE_CAP_HOURS - victim.durationH);
    await expect(
      createQueuedPurchase(newPurchase({ slot: 1, durationH: victim.durationH as 1 | 3 }), NOW),
    ).resolves.toBeTruthy();
  });
});

describe("slotCapacity", () => {
  it("reports the wait, and the surge that goes with it", async () => {
    await seedLive(1, 12, 6);
    await seedQueue(1, 12);
    const capacity = await slotCapacity(db, 1, DURATION_HOURS, NOW);

    expect(capacity.queuedHours).toBe(12);
    expect(capacity.liveRemainingHours).toBeCloseTo(6, 5);
    expect(capacity.waitHours).toBeCloseTo(18, 5);
    expect(capacity.remainingHours).toBeCloseTo(6, 5);
    // Every duration, including 24h — the cap is on the wait, not the booking.
    expect(capacity.availableDurations).toEqual([...DURATION_HOURS]);
    // Surge prices demand, which is what is queued — not the tail of a rental
    // already paid for.
    expect(capacity.multiplierCm).toBe(150);
    expect(capacity.atCapacity).toBe(false);
  });

  // A full slot is a state the UI explains (#10), not an unexplained dead end,
  // so the shape it needs has to be available.
  it("reports a slot past the cap as closed, with nothing available", async () => {
    await seedQueue(1, QUEUE_CAP_HOURS + 3);
    const capacity = await slotCapacity(db, 1, DURATION_HOURS, NOW);

    expect(capacity.atCapacity).toBe(true);
    expect(capacity.remainingHours).toBe(0);
    expect(capacity.availableDurations).toEqual([]);
    expect(capacity.multiplierCm).toBe(200);
  });

  it("reports an empty slot as open at base", async () => {
    const capacity = await slotCapacity(db, 3, DURATION_HOURS, NOW);
    expect(capacity.queuedHours).toBe(0);
    expect(capacity.multiplierCm).toBe(100);
    expect(capacity.availableDurations).toEqual([...DURATION_HOURS]);
  });
});

describe("createQueuedPurchase", () => {
  it("refuses a booking once the wait is past the cap", async () => {
    await seedQueue(1, QUEUE_CAP_HOURS + 3);
    await expect(createQueuedPurchase(newPurchase({ slot: 1, durationH: 1 }), NOW)).rejects.toThrow(
      QueueAtCapacityError,
    );
    // And leaves the queue untouched.
    expect(await queuedHoursForSlot(db, 1)).toBe(QUEUE_CAP_HOURS + 3);
  });

  it("accepts a booking joining at exactly the cap", async () => {
    await seedQueue(1, QUEUE_CAP_HOURS);
    await expect(
      createQueuedPurchase(newPurchase({ slot: 1, durationH: 3 }), NOW),
    ).resolves.toBeTruthy();
  });

  it("accepts a 24h booking on an empty slot", async () => {
    await expect(
      createQueuedPurchase(newPurchase({ slot: 1, durationH: 24 }), NOW),
    ).resolves.toBeTruthy();
    expect(await queuedHoursForSlot(db, 1)).toBe(24);
  });

  it("caps each slot independently", async () => {
    await seedQueue(1, QUEUE_CAP_HOURS + 3);
    await expect(createQueuedPurchase(newPurchase({ slot: 1, durationH: 1 }), NOW)).rejects.toThrow(
      QueueAtCapacityError,
    );
    await expect(
      createQueuedPurchase(newPurchase({ slot: 2, durationH: 12 }), NOW),
    ).resolves.toBeTruthy();
  });

  /**
   * The scenario the cap exists to survive.
   *
   * The cap is a sum across rows, so no check constraint can express it. Two
   * transactions at READ COMMITTED would both read 12 queued hours and both
   * insert 6, leaving 24 against a cap of 18. SERIALIZABLE is what makes that
   * impossible.
   */
  it("does not let concurrent purchases push the wait past the cap", async () => {
    await seedQueue(1, 21);
    const CONTENDERS = 10;

    const results = await Promise.allSettled(
      Array.from({ length: CONTENDERS }, (_, i) =>
        createQueuedPurchase(newPurchase({ slot: 1, durationH: 3, handle: `rush_${i}` }), NOW),
      ),
    );

    // Serialised, so each sees the queue the previous one left. The first takes
    // it to 24 (exactly the cap, so acceptable), the second to 27 (past it), and
    // everything after is refused.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await queuedHoursForSlot(db, 1)).toBe(27);
  });

  /**
   * The scenario the cap exists to survive.
   *
   * The cap is a sum across rows, so no check constraint can express it. At READ
   * COMMITTED every one of these transactions would read an empty queue and
   * commit, leaving 72 queued hours. SERIALIZABLE is what makes that impossible.
   */
  it("never lets a rush from empty exceed the cap plus one booking", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        createQueuedPurchase(
          newPurchase({ slot: 2, durationH: 6, handle: `empty_rush_${i}` }),
          NOW,
        ),
      ),
    );

    // The exact number admitted is not a specification: under contention some
    // transactions exhaust their retry budget and fail rather than being
    // admitted, which is a legitimate outcome (#26 retries or refunds). What is
    // guaranteed is the invariant — nobody was admitted to a wait past the cap,
    // so the queue cannot exceed the cap plus one maximum booking.
    const admitted = results.filter((r) => r.status === "fulfilled").length;
    expect(admitted).toBeGreaterThan(0);

    const queued = await queuedHoursForSlot(db, 2);
    expect(queued).toBeLessThanOrEqual(QUEUE_CAP_HOURS + 24);
    // Every admitted booking is 6h, and the last admitted joined at or under the
    // cap, so the queue lands within one booking of it.
    expect(queued).toBe(admitted * 6);
    expect((admitted - 1) * 6).toBeLessThanOrEqual(QUEUE_CAP_HOURS);
  });

  /**
   * The bound that matters, and the number worth stating in the pricing dialog
   * (#14): whatever the queue does, nobody joins a wait longer than the cap.
   */
  it("never admits anyone to a wait longer than the cap", async () => {
    const waitsAtJoin: number[] = [];

    for (let i = 0; i < 30; i += 1) {
      const before = await waitHoursForSlot(db, 3, NOW);
      try {
        await createQueuedPurchase(
          newPurchase({ slot: 3, durationH: 6, handle: `drip_${i}` }),
          NOW,
        );
        waitsAtJoin.push(before);
      } catch (error) {
        expect(error).toBeInstanceOf(QueueAtCapacityError);
      }
    }

    expect(waitsAtJoin.length).toBeGreaterThan(0);
    for (const wait of waitsAtJoin) {
      expect(wait).toBeLessThanOrEqual(QUEUE_CAP_HOURS);
    }
  });
});
