import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { quoteForQueue, type DurationHours, type Slot } from "@/lib/pricing";

import {
  NotKillableError,
  currentBoard,
  killPurchase,
  liveOnSlot,
  promoteAll,
  promoteSlot,
  queueForSlot,
  tape,
} from "./state";

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

/** A queued purchase, bought `minutesAgo` before NOW so queue order is explicit. */
async function queue(slot: Slot, durationH: DurationHours, minutesAgo: number, handle: string) {
  return db.purchase.create({
    data: row({ slot, durationH, handle, boughtAt: new Date(NOW.getTime() - minutesAgo * 60_000) }),
  });
}

/** A live purchase whose window is `startsAt` to `startsAt + durationH`. */
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

beforeEach(async () => {
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.purchase.deleteMany();
  await db.$disconnect();
});

describe("liveness is derived from the window, not from status", () => {
  /**
   * The claim the whole design rests on: a rental whose window has closed is off
   * the board, whether or not anything ran to notice. This read promotes nothing
   * and materialises nothing.
   */
  it("excludes a rental whose window closed, with no scheduler and no promotion", async () => {
    await live(1, 3, new Date(NOW.getTime() - 4 * HOUR), "expired_one");

    expect(await liveOnSlot(1, NOW)).toBeNull();

    // And the row is untouched — nothing wrote to it to make that true.
    const stored = await db.purchase.findFirstOrThrow({ where: { handle: "expired_one" } });
    expect(stored.status).toBe("live");
  });

  it("includes a rental whose window contains now", async () => {
    await live(1, 6, new Date(NOW.getTime() - 2 * HOUR), "running");
    expect((await liveOnSlot(1, NOW))?.handle).toBe("running");
  });

  it("excludes a rental whose window has not opened", async () => {
    await live(1, 3, new Date(NOW.getTime() + HOUR), "future");
    expect(await liveOnSlot(1, NOW)).toBeNull();
  });

  it("treats the window as half-open, so a rental ends exactly on its end time", async () => {
    const startsAt = new Date(NOW.getTime() - 3 * HOUR);
    await live(1, 3, startsAt, "ends_now"); // endsAt === NOW

    expect(await liveOnSlot(1, NOW)).toBeNull();
    expect((await liveOnSlot(1, new Date(NOW.getTime() - 1)))?.handle).toBe("ends_now");
  });

  /**
   * The restart test the issue asks for. Rows are constructed in every temporal
   * relationship to now, and the board is read with nothing having run — no
   * scheduler, no prior promotion, no process that ever observed an expiry.
   */
  it("reports the same board after a restart, with nothing having run", async () => {
    await live(1, 3, new Date(NOW.getTime() - 4 * HOUR), "slot1_expired");
    await live(2, 6, new Date(NOW.getTime() - 2 * HOUR), "slot2_running");
    await live(3, 3, new Date(NOW.getTime() + 2 * HOUR), "slot3_future");

    const board = await Promise.all([liveOnSlot(1, NOW), liveOnSlot(2, NOW), liveOnSlot(3, NOW)]);

    expect(board.map((r) => r?.handle ?? null)).toEqual([null, "slot2_running", null]);
  });
});

describe("promotion", () => {
  it("promotes the oldest queued purchase into an empty slot", async () => {
    await queue(1, 3, 30, "first_in");
    await queue(1, 3, 10, "second_in");

    const promoted = await promoteSlot(1, NOW);

    expect(promoted?.handle).toBe("first_in");
    expect(promoted?.startsAt).toEqual(NOW);
    expect(promoted?.endsAt).toEqual(new Date(NOW.getTime() + 3 * HOUR));
    expect((await liveOnSlot(1, NOW))?.handle).toBe("first_in");
  });

  it("does not promote into a slot whose rental is still running", async () => {
    await live(1, 6, new Date(NOW.getTime() - 2 * HOUR), "running");
    await queue(1, 3, 10, "waiting");

    expect(await promoteSlot(1, NOW)).toBeNull();
    expect((await liveOnSlot(1, NOW))?.handle).toBe("running");
  });

  /**
   * Promoting into a slot whose previous rental expired must not depend on
   * anything having observed that expiry. Nothing ran between the expiry and
   * this call.
   */
  it("promotes over an expired rental that nothing ever noticed", async () => {
    await live(1, 3, new Date(NOW.getTime() - 5 * HOUR), "long_gone");
    await queue(1, 3, 10, "next_up");

    const promoted = await promoteSlot(1, NOW);

    expect(promoted?.handle).toBe("next_up");
    const previous = await db.purchase.findFirstOrThrow({ where: { handle: "long_gone" } });
    expect(previous.status).toBe("ended");
  });

  it("does nothing when the queue is empty", async () => {
    expect(await promoteSlot(3, NOW)).toBeNull();
  });

  it("promotes each slot independently", async () => {
    await queue(1, 3, 10, "one");
    await queue(2, 3, 10, "two");
    await queue(3, 3, 10, "three");

    const promoted = await promoteAll(NOW);
    expect(promoted.map((r) => r.handle).sort()).toEqual(["one", "three", "two"]);
  });

  /**
   * The concurrency scenario. The partial unique index from #21 is what makes
   * this safe: at most one live row per slot, however many transactions race.
   */
  it("lets exactly one of many concurrent promotions win", async () => {
    await queue(1, 3, 30, "first_in");
    await queue(1, 3, 20, "second_in");
    await queue(1, 3, 10, "third_in");

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => promoteSlot(1, NOW)));

    const promoted = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof promoteSlot>>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value)
      .filter((v) => v !== null);

    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.handle).toBe("first_in");
    expect(await db.purchase.count({ where: { slot: 1, status: "live" } })).toBe(1);
    // The other two are untouched and still in order.
    expect((await queueForSlot(1)).map((r) => r.handle)).toEqual(["second_in", "third_in"]);
  });

  it("never leaves two live rows on one slot under a concurrent rush", async () => {
    for (let i = 0; i < 6; i += 1) await queue(2, 1, 60 - i, `rush_${i}`);

    await Promise.allSettled(Array.from({ length: 12 }, () => promoteSlot(2, NOW)));

    expect(await db.purchase.count({ where: { slot: 2, status: "live" } })).toBe(1);
  });
});

describe("the board", () => {
  it("promotes as a side effect of being read", async () => {
    await queue(1, 3, 10, "waiting");

    const board = await currentBoard(NOW);

    expect(board.find((s) => s.slot === 1)?.live?.handle).toBe("waiting");
  });

  it("reports an empty board as three open slots", async () => {
    const board = await currentBoard(NOW);
    expect(board).toHaveLength(3);
    expect(board.every((s) => s.live === null && s.queuedHours === 0)).toBe(true);
  });

  it("reports queued hours and counts per slot", async () => {
    await live(1, 6, new Date(NOW.getTime() - HOUR), "running");
    await queue(1, 3, 30, "q1");
    await queue(1, 6, 20, "q2");
    await queue(2, 1, 10, "q3");

    const board = await currentBoard(NOW);
    const slot1 = board.find((s) => s.slot === 1);

    expect(slot1?.live?.handle).toBe("running");
    expect(slot1?.queuedHours).toBe(9);
    expect(slot1?.queuedCount).toBe(2);
  });

  it("hands a freed slot to the next in line in one read", async () => {
    await live(1, 3, new Date(NOW.getTime() - 4 * HOUR), "finished");
    await queue(1, 3, 30, "next_up");

    const board = await currentBoard(NOW);

    expect(board.find((s) => s.slot === 1)?.live?.handle).toBe("next_up");
    expect(board.find((s) => s.slot === 1)?.queuedHours).toBe(0);
  });

  it("opens no transaction when there is nothing to promote", async () => {
    await live(1, 6, new Date(NOW.getTime() - HOUR), "running");
    // No queue behind it, and its window is open — so nothing should change.
    const before = await db.purchase.findFirstOrThrow({ where: { handle: "running" } });
    await currentBoard(NOW);
    const after = await db.purchase.findFirstOrThrow({ where: { handle: "running" } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe("derived views", () => {
  it("orders the queue oldest first and the tape newest first", async () => {
    await queue(1, 3, 30, "older");
    await queue(1, 3, 10, "newer");

    expect((await queueForSlot(1)).map((r) => r.handle)).toEqual(["older", "newer"]);

    // Each ended row starts after it was bought, which the schema enforces.
    for (const [handle, minutesAgo] of [
      ["ended_older", 600],
      ["ended_newer", 300],
    ] as const) {
      const boughtAt = new Date(NOW.getTime() - minutesAgo * 60_000);
      const startsAt = new Date(boughtAt.getTime() + 5 * 60_000);
      await db.purchase.create({
        data: row({
          slot: 2,
          handle,
          status: "ended" as const,
          boughtAt,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3 * HOUR),
        }),
      });
    }

    expect((await tape()).map((r) => r.handle)).toEqual(["ended_newer", "ended_older"]);
  });
});

describe("promotion is independent of clock skew", () => {
  /**
   * boughtAt is stamped by the database while `now` comes from the application
   * clock. If the app server runs behind the database, a rental promoted moments
   * after purchase would start before it was bought and
   * purchase_starts_after_bought (#21) would reject the promotion outright.
   */
  it("never starts a rental before it was bought", async () => {
    // Row bought at NOW, promoted with an application clock a minute behind.
    await db.purchase.create({ data: row({ slot: 1, handle: "just_bought", boughtAt: NOW }) });

    const skewedNow = new Date(NOW.getTime() - 60_000);
    const promoted = await promoteSlot(1, skewedNow);

    expect(promoted).not.toBeNull();
    expect(promoted!.startsAt!.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(promoted!.endsAt!.getTime()).toBe(
      promoted!.startsAt!.getTime() + promoted!.durationH * HOUR,
    );
  });

  it("uses the application clock when it is ahead of the purchase", async () => {
    await queue(1, 3, 30, "bought_earlier");
    const promoted = await promoteSlot(1, NOW);
    expect(promoted!.startsAt).toEqual(NOW);
  });
});

describe("the board survives a failed promotion", () => {
  /**
   * The read consults only the window, so it is correct whether or not promotion
   * succeeded. Failing the whole board read over a contended write would take
   * the site down for something #22's job redoes within the hour.
   */
  it("still serves the board when promotion throws", async () => {
    await live(1, 6, new Date(NOW.getTime() - 2 * HOUR), "running");

    const state = await import("./state");
    const queueModule = await import("./queue");
    const original = queueModule.inSerializableTransaction;

    // Force every promotion attempt to fail the way an exhausted retry budget does.
    const spy = vi
      .spyOn(queueModule, "inSerializableTransaction")
      .mockRejectedValue(new Error("could not serialize access"));

    try {
      await db.purchase.create({ data: row({ slot: 2, handle: "waiting", boughtAt: NOW }) });
      const board = await state.currentBoard(NOW);

      expect(board.find((s) => s.slot === 1)?.live?.handle).toBe("running");
      expect(board.find((s) => s.slot === 2)?.live).toBeNull();
    } finally {
      spy.mockRestore();
      expect(queueModule.inSerializableTransaction).toBe(original);
    }
  });
});

describe("killing a listing (#17)", () => {
  it("frees a live slot and promotes the next in line in one transaction", async () => {
    const running = await live(1, 6, new Date(NOW.getTime() - HOUR), "impersonator");
    await queue(1, 3, 30, "next_up");

    const { killed, promoted } = await killPurchase(running.id, "impersonation", NOW);

    expect(killed.status).toBe("killed");
    expect(killed.killedAt).toEqual(NOW);
    expect(promoted?.handle).toBe("next_up");
    expect((await liveOnSlot(1, NOW))?.handle).toBe("next_up");
  });

  it("keeps the killed row in the ledger rather than deleting it", async () => {
    const running = await live(1, 6, new Date(NOW.getTime() - HOUR), "impersonator");
    await killPurchase(running.id, "impersonation", NOW);

    const stored = await db.purchase.findUniqueOrThrow({ where: { id: running.id } });
    expect(stored.status).toBe("killed");
    expect(stored.killedReason).toBe("impersonation");
  });

  // The tape is a record and does not get rewritten. Killing an ended rental
  // would quietly remove it from the tape, since the tape filters on `ended`.
  it("refuses to kill a rental that has already ended", async () => {
    const boughtAt = new Date(NOW.getTime() - 11 * HOUR);
    const startsAt = new Date(NOW.getTime() - 10 * HOUR);
    const ended = await db.purchase.create({
      data: row({
        slot: 2,
        handle: "finished",
        status: "ended" as const,
        boughtAt,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * HOUR),
      }),
    });

    await expect(killPurchase(ended.id, "too late", NOW)).rejects.toThrow(NotKillableError);
    expect((await tape()).map((r) => r.handle)).toContain("finished");
  });

  // A double click would otherwise overwrite the audit trail's timestamp and
  // reason with the second attempt's.
  it("refuses to kill the same listing twice", async () => {
    const running = await live(1, 6, new Date(NOW.getTime() - HOUR), "impersonator");
    await killPurchase(running.id, "impersonation", NOW);

    const later = new Date(NOW.getTime() + 60_000);
    await expect(killPurchase(running.id, "changed my mind", later)).rejects.toThrow(
      NotKillableError,
    );

    const stored = await db.purchase.findUniqueOrThrow({ where: { id: running.id } });
    expect(stored.killedAt).toEqual(NOW);
    expect(stored.killedReason).toBe("impersonation");
  });

  it("kills from the queue without touching the live rental", async () => {
    await live(1, 6, new Date(NOW.getTime() - HOUR), "running");
    const waiting = await queue(1, 3, 30, "bad_actor");

    const { promoted } = await killPurchase(waiting.id, "malicious link", NOW);

    expect(promoted).toBeNull();
    expect((await liveOnSlot(1, NOW))?.handle).toBe("running");
    expect(await queueForSlot(1)).toHaveLength(0);
  });
});
