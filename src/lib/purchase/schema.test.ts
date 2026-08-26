import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";

/**
 * These tests exercise the database constraints directly, because that is where
 * the guarantees live. #1 solves concurrent promotion with database guarantees
 * rather than application locks — if a constraint here can be violated, that
 * approach does not work.
 *
 * They talk to a real Postgres. No mocks: a mocked constraint proves nothing.
 */

const db = getDb();

/** A complete, valid queued row. Overridable per test. */
function queuedRow(overrides: Record<string, unknown> = {}) {
  return {
    slot: 1,
    handle: "mira_builds",
    platform: "github" as const,
    targetUrl: "https://github.com/mira_builds",
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
    durationH: 3,
    priceHrCents: 833,
    totalPaidCents: 833 * 3,
    ...overrides,
  };
}

/**
 * A live row occupying `slot`, bought before it started.
 *
 * boughtAt is set explicitly rather than left to default: the database default
 * is evaluated at insert time, which lands after a startsAt computed here and
 * trips purchase_starts_after_bought. Real rows are bought, queued, and only
 * then promoted, so an explicit earlier boughtAt is also the truthful fixture.
 */
function liveRow(slot: number, overrides: Record<string, unknown> = {}) {
  const durationH = 3;
  const boughtAt = new Date(Date.now() - 60 * 60_000);
  const startsAt = new Date(boughtAt.getTime() + 30 * 60_000);
  return queuedRow({
    slot,
    status: "live" as const,
    boughtAt,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationH * 3_600_000),
    durationH,
    ...overrides,
  });
}

beforeEach(async () => {
  await db.purchase.deleteMany();
  await db.askSample.deleteMany();
});

afterAll(async () => {
  await db.purchase.deleteMany();
  await db.askSample.deleteMany();
  await db.$disconnect();
});

describe("one live rental per slot", () => {
  it("permits one live row per slot across all three slots", async () => {
    await db.purchase.create({ data: liveRow(1) });
    await db.purchase.create({ data: liveRow(2) });
    await db.purchase.create({ data: liveRow(3) });

    expect(await db.purchase.count({ where: { status: "live" } })).toBe(3);
  });

  it("refuses a second live row on the same slot", async () => {
    await db.purchase.create({ data: liveRow(1) });
    await expect(db.purchase.create({ data: liveRow(1) })).rejects.toThrowError();
  });

  // The scenario #1 has to survive: several checkouts promoting into one slot at
  // the same instant. Exactly one must win; the rest must fail cleanly so they
  // can retry, rather than all succeeding and corrupting the board.
  it("lets exactly one of many concurrent promotions win", async () => {
    const CONTENDERS = 12;

    const results = await Promise.allSettled(
      Array.from({ length: CONTENDERS }, (_, i) =>
        db.purchase.create({ data: liveRow(1, { handle: `contender_${i}` }) }),
      ),
    );

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(CONTENDERS - 1);
    expect(await db.purchase.count({ where: { slot: 1, status: "live" } })).toBe(1);
  });

  // Queued and ended rows are outside the partial index, so a slot can hold any
  // number of them. The ledger depends on this.
  it("permits many queued and ended rows on one slot", async () => {
    await db.purchase.createMany({
      data: Array.from({ length: 5 }, (_, i) => queuedRow({ handle: `queued_${i}` })),
    });

    const boughtAt = new Date(Date.now() - 11 * 3_600_000);
    const startsAt = new Date(Date.now() - 10 * 3_600_000);
    await db.purchase.createMany({
      data: Array.from({ length: 5 }, (_, i) =>
        queuedRow({
          handle: `ended_${i}`,
          status: "ended" as const,
          boughtAt,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        }),
      ),
    });

    expect(await db.purchase.count({ where: { slot: 1 } })).toBe(10);
  });
});

describe("value constraints", () => {
  it.each([0, 4, -1])("rejects slot %i", async (slot) => {
    await expect(db.purchase.create({ data: queuedRow({ slot }) })).rejects.toThrowError();
  });

  it.each([1, 3, 6, 12, 24])("accepts the %ih snap point", async (durationH) => {
    const row = await db.purchase.create({
      data: queuedRow({ durationH, totalPaidCents: 833 * durationH }),
    });
    expect(row.durationH).toBe(durationH);
  });

  it.each([2, 5, 7, 48])("rejects %ih, which is not a snap point", async (durationH) => {
    await expect(
      db.purchase.create({ data: queuedRow({ durationH, totalPaidCents: 833 * durationH }) }),
    ).rejects.toThrowError();
  });

  it("rejects a total that disagrees with rate times hours", async () => {
    await expect(
      db.purchase.create({
        data: queuedRow({ priceHrCents: 833, durationH: 3, totalPaidCents: 1 }),
      }),
    ).rejects.toThrowError();
  });

  it("rejects a free rental", async () => {
    await expect(
      db.purchase.create({ data: queuedRow({ priceHrCents: 0, totalPaidCents: 0 }) }),
    ).rejects.toThrowError();
  });

  it("rejects a non-https target", async () => {
    await expect(
      db.purchase.create({ data: queuedRow({ targetUrl: "http://github.com/mira" }) }),
    ).rejects.toThrowError();
  });
});

describe("status and timestamps agree", () => {
  it("rejects a queued row that has already started", async () => {
    const startsAt = new Date();
    await expect(
      db.purchase.create({
        data: queuedRow({
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        }),
      }),
    ).rejects.toThrowError();
  });

  it("rejects a live row with no window", async () => {
    await expect(
      db.purchase.create({ data: queuedRow({ status: "live" as const }) }),
    ).rejects.toThrowError();
  });

  // The countdown (#3) and the depletion bar (#7) both derive from this window.
  // A row where it does not hold would render a rental outliving what was paid for.
  it("rejects a window longer than the booked duration", async () => {
    const startsAt = new Date();
    await expect(
      db.purchase.create({
        data: queuedRow({
          status: "live" as const,
          durationH: 3,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
        }),
      }),
    ).rejects.toThrowError();
  });

  it("rejects a rental starting before it was bought", async () => {
    const boughtAt = new Date();
    const startsAt = new Date(boughtAt.getTime() - 60_000);
    await expect(
      db.purchase.create({
        data: queuedRow({
          status: "live" as const,
          boughtAt,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        }),
      }),
    ).rejects.toThrowError();
  });

  it("rejects a killed row with no killedAt", async () => {
    await expect(
      db.purchase.create({ data: queuedRow({ status: "killed" as const }) }),
    ).rejects.toThrowError();
  });

  // #17: a listing can be killed from the queue or off the board, so a killed
  // row may or may not have started.
  it("accepts a listing killed from the queue", async () => {
    const row = await db.purchase.create({
      data: queuedRow({
        status: "killed" as const,
        killedAt: new Date(),
        killedReason: "impersonation",
      }),
    });
    expect(row.startsAt).toBeNull();
  });

  it("accepts a listing killed while live", async () => {
    const boughtAt = new Date(Date.now() - 60 * 60_000);
    const startsAt = new Date(boughtAt.getTime() + 30 * 60_000);
    const row = await db.purchase.create({
      data: queuedRow({
        status: "killed" as const,
        boughtAt,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
        killedAt: new Date(),
        killedReason: "malicious link",
      }),
    });
    expect(row.startsAt).not.toBeNull();
  });
});

describe("platform and display name", () => {
  it("requires a display name for websites", async () => {
    await expect(
      db.purchase.create({
        data: queuedRow({ platform: "web" as const, targetUrl: "https://ledgerless.dev" }),
      }),
    ).rejects.toThrowError();
  });

  it("accepts a website with a display name", async () => {
    const row = await db.purchase.create({
      data: queuedRow({
        platform: "web" as const,
        handle: "",
        displayName: "Ledgerless",
        targetUrl: "https://ledgerless.dev",
      }),
    });
    expect(row.displayName).toBe("Ledgerless");
  });

  it("refuses a display name on a platform that shows a handle", async () => {
    await expect(
      db.purchase.create({ data: queuedRow({ displayName: "Mira" }) }),
    ).rejects.toThrowError();
  });
});

describe("idempotency of the Stripe webhook", () => {
  // #26 relies on this constraint rather than a check-then-write, because Stripe
  // retries and two deliveries can land concurrently.
  it("refuses a second purchase for one checkout session", async () => {
    await db.purchase.create({ data: queuedRow({ stripeSessionId: "cs_test_abc123" }) });
    await expect(
      db.purchase.create({ data: queuedRow({ stripeSessionId: "cs_test_abc123" }) }),
    ).rejects.toThrowError();
  });

  it("lets exactly one of two concurrent deliveries create the row", async () => {
    const results = await Promise.allSettled([
      db.purchase.create({ data: queuedRow({ stripeSessionId: "cs_test_race" }) }),
      db.purchase.create({ data: queuedRow({ stripeSessionId: "cs_test_race" }) }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.purchase.count({ where: { stripeSessionId: "cs_test_race" } })).toBe(1);
  });
});

describe("ask samples", () => {
  const hour = () => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    return d;
  };

  // #22 must be idempotent under repeat and concurrent runs, by constraint
  // rather than by checking first.
  it("refuses two samples for the same slot and hour", async () => {
    const data = { slot: 1, hour: hour(), askHrCents: 833, baseHrCents: 500, queuedHours: 12 };
    await db.askSample.create({ data });
    await expect(db.askSample.create({ data })).rejects.toThrowError();
  });

  it("rejects a sample stamped mid-hour", async () => {
    const midHour = new Date();
    midHour.setMinutes(37, 0, 0);
    await expect(
      db.askSample.create({
        data: { slot: 1, hour: midHour, askHrCents: 833, baseHrCents: 500, queuedHours: 12 },
      }),
    ).rejects.toThrowError();
  });

  // Decision D2 caps surge at 2x. A sample outside that band means the pricing
  // engine produced something impossible.
  it("rejects an ask above the 2x surge cap", async () => {
    await expect(
      db.askSample.create({
        data: { slot: 1, hour: hour(), askHrCents: 1001, baseHrCents: 500, queuedHours: 99 },
      }),
    ).rejects.toThrowError();
  });

  it("rejects an ask below base", async () => {
    await expect(
      db.askSample.create({
        data: { slot: 1, hour: hour(), askHrCents: 499, baseHrCents: 500, queuedHours: 0 },
      }),
    ).rejects.toThrowError();
  });

  it("accepts an ask at exactly base and at exactly the cap", async () => {
    const h = hour();
    await db.askSample.create({
      data: { slot: 1, hour: h, askHrCents: 500, baseHrCents: 500, queuedHours: 0 },
    });
    await db.askSample.create({
      data: { slot: 2, hour: h, askHrCents: 1000, baseHrCents: 500, queuedHours: 18 },
    });
    expect(await db.askSample.count()).toBe(2);
  });
});
