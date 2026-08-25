import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/lib/db";
import { quoteForQueue, type DurationHours, type Slot } from "@/lib/pricing";
import { currentBoard, liveOnSlot } from "@/lib/purchase/state";

import { runHourlyTick, sampleAsks, sampledHours, truncateToHour } from "./sampler";

const db = getDb();
const HOUR = 3_600_000;
const NOW = new Date("2026-08-25T12:30:00.000Z");
const THIS_HOUR = new Date("2026-08-25T12:00:00.000Z");

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
    tagline: "tagline",
    priceHrCents: q.askHrCents,
    totalPaidCents: q.totalCents,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.askSample.deleteMany();
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.askSample.deleteMany();
  await db.purchase.deleteMany();
  await db.$disconnect();
});

describe("the job holds no load-bearing state", () => {
  /**
   * The property this whole design exists to protect. Liveness is derived from
   * timestamps (#1), so the board must be correct with the scheduler disabled
   * entirely — not merely correct once it next runs.
   */
  it("renders a correct board with the scheduler never having run", async () => {
    const startsAt = new Date(NOW.getTime() - 5 * HOUR);
    await db.purchase.create({
      data: row({
        slot: 1,
        handle: "expired",
        status: "live" as const,
        boughtAt: new Date(startsAt.getTime() - 60_000),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
      }),
    });
    await db.purchase.create({
      data: row({ slot: 1, handle: "waiting", boughtAt: new Date(NOW.getTime() - HOUR) }),
    });

    // No runHourlyTick anywhere in this test.
    expect(await liveOnSlot(1, NOW)).toBeNull();

    const board = await currentBoard(NOW);
    expect(board.find((s) => s.slot === 1)?.live?.handle).toBe("waiting");
    expect(await db.askSample.count()).toBe(0);
  });

  it("loses only samples when it stops, never board correctness", async () => {
    await db.purchase.create({
      data: row({ slot: 2, handle: "waiting", boughtAt: new Date(NOW.getTime() - HOUR) }),
    });

    // Two hours pass with no tick at all.
    const later = new Date(NOW.getTime() + 2 * HOUR);
    const board = await currentBoard(later);

    expect(board.find((s) => s.slot === 2)?.live?.handle).toBe("waiting");
    expect(await sampledHours(2)).toBe(0);
  });
});

describe("hourly sampling", () => {
  it("truncates to the top of the hour", () => {
    expect(truncateToHour(NOW)).toEqual(THIS_HOUR);
    expect(truncateToHour(THIS_HOUR)).toEqual(THIS_HOUR);
  });

  it("writes one sample per slot", async () => {
    const result = await sampleAsks(NOW);

    expect(result.hour).toEqual(THIS_HOUR);
    expect(result.written).toHaveLength(3);
    expect(await db.askSample.count()).toBe(3);
  });

  it("samples base when nothing is queued", async () => {
    await sampleAsks(NOW);
    const slot1 = await db.askSample.findFirstOrThrow({ where: { slot: 1 } });

    expect(slot1.askHrCents).toBe(500);
    expect(slot1.baseHrCents).toBe(500);
    expect(slot1.queuedHours).toBe(0);
  });

  it("samples the surge the queue justifies", async () => {
    for (let i = 0; i < 4; i += 1) {
      await db.purchase.create({
        data: row({
          slot: 1,
          durationH: 3,
          handle: `q${i}`,
          boughtAt: new Date(NOW.getTime() - i),
        }),
      });
    }

    await sampleAsks(NOW);
    const slot1 = await db.askSample.findFirstOrThrow({ where: { slot: 1 } });

    // 12 queued hours -> 1.50x -> $7.50, the prototype's own queue depth.
    expect(slot1.queuedHours).toBe(12);
    expect(slot1.askHrCents).toBe(750);
  });

  /**
   * Idempotent by constraint, not by checking first — `ask_sample` is unique on
   * (slot, hour) (#21). Checking first would still race.
   */
  it("writes one row per hour however many times it runs", async () => {
    await sampleAsks(NOW);
    const second = await sampleAsks(new Date(NOW.getTime() + 5 * 60_000));

    expect(second.written).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(await db.askSample.count()).toBe(3);
  });

  it("writes one row per hour under concurrent runs", async () => {
    await Promise.allSettled(Array.from({ length: 6 }, () => sampleAsks(NOW)));
    expect(await db.askSample.count()).toBe(3);
  });

  it("writes a new row once the hour rolls over", async () => {
    await sampleAsks(NOW);
    await sampleAsks(new Date(NOW.getTime() + HOUR));

    expect(await sampledHours(1)).toBe(2);
  });
});

describe("decay", () => {
  it("carries the previous hour's ask forward, bleeding toward base", async () => {
    // An hour at full surge: 24 queued hours reaches the 2.00x ceiling.
    for (let i = 0; i < 8; i += 1) {
      await db.purchase.create({
        data: row({
          slot: 1,
          durationH: 3,
          handle: `q${i}`,
          boughtAt: new Date(NOW.getTime() - i),
        }),
      });
    }
    await sampleAsks(NOW);
    expect((await db.askSample.findFirstOrThrow({ where: { slot: 1 } })).askHrCents).toBe(1000);

    // The queue drains, and the next hour is sampled.
    await db.purchase.deleteMany({ where: { status: "queued" } });
    await sampleAsks(new Date(NOW.getTime() + HOUR));

    const next = await db.askSample.findFirstOrThrow({
      where: { slot: 1, hour: new Date(THIS_HOUR.getTime() + HOUR) },
    });

    // Retains 95% of the distance above base: 2.00x -> 1.95x.
    expect(next.askHrCents).toBe(975);
    expect(next.queuedHours).toBe(0);
  });

  it("converges to base over enough unsold hours, and stops there", async () => {
    for (let i = 0; i < 8; i += 1) {
      await db.purchase.create({
        data: row({
          slot: 3,
          durationH: 3,
          handle: `q${i}`,
          boughtAt: new Date(NOW.getTime() - i),
        }),
      });
    }
    await sampleAsks(NOW);
    await db.purchase.deleteMany({ where: { status: "queued" } });

    for (let h = 1; h <= 120; h += 1) await sampleAsks(new Date(NOW.getTime() + h * HOUR));

    const latest = await db.askSample.findFirstOrThrow({
      where: { slot: 3 },
      orderBy: { hour: "desc" },
    });
    expect(latest.askHrCents).toBe(latest.baseHrCents);
  });
});

describe("gaps stay gaps", () => {
  /**
   * Never interpolate, never pad. An hour with no sample is an hour with no
   * candle, and #13 renders that honestly rather than drawing a flat line
   * dressed up as activity.
   */
  it("does not backfill a missed hour", async () => {
    await sampleAsks(NOW);
    // Three hours pass with no run, then one at the fourth.
    await sampleAsks(new Date(NOW.getTime() + 4 * HOUR));

    const hours = await db.askSample.findMany({ where: { slot: 1 }, orderBy: { hour: "asc" } });

    expect(hours).toHaveLength(2);
    expect(hours[1].hour.getTime() - hours[0].hour.getTime()).toBe(4 * HOUR);
  });
});

describe("the tick", () => {
  it("promotes before sampling, so the sample reflects the settled queue", async () => {
    await db.purchase.create({
      data: row({
        slot: 1,
        durationH: 3,
        handle: "waiting",
        boughtAt: new Date(NOW.getTime() - HOUR),
      }),
    });

    const result = await runHourlyTick(NOW);

    expect(result.promoted).toBe(1);
    expect(result.samplesWritten).toBe(3);
    // The promoted row is live, so it is no longer queued hours driving surge.
    expect((await db.askSample.findFirstOrThrow({ where: { slot: 1 } })).queuedHours).toBe(0);
  });

  it("reports what it did", async () => {
    const result = await runHourlyTick(NOW);
    expect(result).toMatchObject({ hour: THIS_HOUR, samplesWritten: 3, samplesSkipped: 0 });
  });
});
