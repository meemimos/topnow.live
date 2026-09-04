import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";

import { COUNTS_CACHE_MS, ONLINE_WINDOW_MS, VISIT_WINDOW_MS } from "./constants";
import { readCounts, recordVisit, resetCountsCache } from "./store";

/**
 * The counters (#15).
 *
 * Two rules under test, both from the issue. **The number floors at the truth**
 * — nothing rounds up and zero is printable. And **a page render never triggers
 * a counting query** — reads come from a cache, so however many people are
 * looking, the database sees one query per interval.
 */

const db = getDb();
const NOW = new Date("2026-09-04T12:00:00.000Z");
const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

function visitor(address: string, userAgent = CHROME): Headers {
  return new Headers({ "x-forwarded-for": address, "user-agent": userAgent });
}

beforeEach(async () => {
  await db.visit.deleteMany();
  resetCountsCache();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.visit.deleteMany();
});

describe("recordVisit", () => {
  it("records one visitor", async () => {
    expect(await recordVisit(visitor("203.0.113.9"), NOW)).toBe("created");
    expect(await db.visit.count()).toBe(1);
  });

  it("stores a hash, never an address or a user agent", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    const row = await db.visit.findFirstOrThrow();

    expect(row.visitorHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    expect(JSON.stringify(row)).not.toContain("Chrome");
  });

  it("counts a reload as the same visit", async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordVisit(visitor("203.0.113.9"), new Date(NOW.getTime() + i * 1000));
    }
    // Ten reloads is one person looking, and the counter says so.
    expect(await db.visit.count()).toBe(1);
  });

  it("counts a return after the window as a second visit", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    await recordVisit(visitor("203.0.113.9"), new Date(NOW.getTime() + VISIT_WINDOW_MS));
    expect(await db.visit.count()).toBe(2);
  });

  it("counts two visitors separately", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    await recordVisit(visitor("198.51.100.7"), NOW);
    expect(await db.visit.count()).toBe(2);
  });

  it("does not count a bot at all", async () => {
    expect(await recordVisit(visitor("203.0.113.9", "Googlebot/2.1"), NOW)).toBe("bot");
    expect(await db.visit.count()).toBe(0);
  });

  it("does not count a request with no user agent", async () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });
    expect(await recordVisit(headers, NOW)).toBe("bot");
    expect(await db.visit.count()).toBe(0);
  });

  it("moves lastSeenAt without creating a row", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    const later = new Date(NOW.getTime() + 60_000);
    await recordVisit(visitor("203.0.113.9"), later);

    const row = await db.visit.findFirstOrThrow();
    expect(row.firstSeenAt.getTime()).toBe(NOW.getTime());
    expect(row.lastSeenAt.getTime()).toBe(later.getTime());
  });

  it("reports a return inside the window as a return, not a new visit", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    // The distinction is what lets a created row correct the cached total by
    // exactly one without ever guessing.
    expect(await recordVisit(visitor("203.0.113.9"), new Date(NOW.getTime() + 5_000))).toBe("seen");
  });

  it("never throws when the write fails", async () => {
    vi.spyOn(db.visit, "updateMany").mockRejectedValueOnce(new Error("connection lost"));
    // A counter is the least important thing on the page. It must not be able to
    // take the board down with it.
    await expect(recordVisit(visitor("203.0.113.9"), NOW)).resolves.toBe("failed");
  });
});

describe("readCounts", () => {
  it("reports zero honestly on an empty database", async () => {
    // Not "at least one", not a friendlier starting number. Launch day is zero.
    expect(await readCounts(NOW)).toEqual({ visits: 0, online: 0 });
  });

  it("counts every visit since launch", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    await recordVisit(visitor("198.51.100.7"), NOW);
    await recordVisit(visitor("203.0.113.9"), new Date(NOW.getTime() + VISIT_WINDOW_MS));

    resetCountsCache();
    expect((await readCounts(new Date(NOW.getTime() + VISIT_WINDOW_MS))).visits).toBe(3);
  });

  it("counts a person online once, not once per window they have visited", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    const later = new Date(NOW.getTime() + VISIT_WINDOW_MS);
    await recordVisit(visitor("203.0.113.9"), later);

    resetCountsCache();
    const counts = await readCounts(later);
    expect(counts.visits).toBe(2);
    // Two visits, one person. Counting rows here would double them.
    expect(counts.online).toBe(1);
  });

  it("drops a visitor out of online once the window passes", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);

    resetCountsCache();
    expect((await readCounts(new Date(NOW.getTime() + ONLINE_WINDOW_MS - 1))).online).toBe(1);

    resetCountsCache();
    const after = await readCounts(new Date(NOW.getTime() + ONLINE_WINDOW_MS + 1));
    // The visit is still a visit; they are just not here any more.
    expect(after.online).toBe(0);
    expect(after.visits).toBe(1);
  });

  it("serves repeated reads from cache rather than querying again", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    resetCountsCache();

    const count = vi.spyOn(db.visit, "count");
    for (let i = 0; i < 20; i += 1) await readCounts(NOW);

    // The whole rule: twenty page renders, one query.
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("shares one query when the cache expires under concurrent reads", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    resetCountsCache();

    const count = vi.spyOn(db.visit, "count");
    await Promise.all(Array.from({ length: 20 }, () => readCounts(NOW)));

    // Without single-flighting, the cache does its job everywhere except the
    // moment it matters — the instant it expires under load.
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("ticks the moment a new visitor arrives, without querying again", async () => {
    resetCountsCache();
    await readCounts(NOW);

    const count = vi.spyOn(db.visit, "count");
    await recordVisit(visitor("203.0.113.9"), NOW);

    // A new row is unambiguously one more visit, so this is arithmetic rather
    // than a second query — and the counter is right immediately rather than
    // up to an interval later.
    expect((await readCounts(NOW)).visits).toBe(1);
    expect(count).not.toHaveBeenCalled();
  });

  it("does not bump the cache for a visitor who was already counted", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    resetCountsCache();
    await readCounts(NOW);

    await recordVisit(visitor("203.0.113.9"), new Date(NOW.getTime() + 1000));
    expect((await readCounts(NOW)).visits).toBe(1);
  });

  it("reads again once the cache has expired", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    resetCountsCache();

    await readCounts(NOW);
    await recordVisit(visitor("198.51.100.7"), NOW);

    const later = new Date(NOW.getTime() + COUNTS_CACHE_MS + 1);
    expect((await readCounts(later)).visits).toBe(2);
  });

  it("falls back to the last known counts rather than throwing", async () => {
    await recordVisit(visitor("203.0.113.9"), NOW);
    resetCountsCache();
    await readCounts(NOW);

    vi.spyOn(db.visit, "count").mockRejectedValue(new Error("database is gone"));
    const later = new Date(NOW.getTime() + COUNTS_CACHE_MS + 1);
    await expect(readCounts(later)).resolves.toEqual({ visits: 1, online: 1 });
  });

  it("reports zero rather than failing when there is nothing cached either", async () => {
    resetCountsCache();
    vi.spyOn(db.visit, "count").mockRejectedValue(new Error("database is gone"));
    await expect(readCounts(NOW)).resolves.toEqual({ visits: 0, online: 0 });
  });
});
