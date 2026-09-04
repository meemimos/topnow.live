import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";
import { consume } from "@/lib/limit/limiter";
import { quoteForQueue } from "@/lib/pricing";

import { REFRESH_AFTER_MS, RETRY_FAILED_AFTER_MS } from "./constants";
import type { Transport } from "@/lib/fetch/net";
import {
  avatarKey,
  avatarLookupKey,
  ensureAvatar,
  isStale,
  readAvatars,
  refreshStaleAvatars,
} from "./store";

/**
 * The avatar cache (#19).
 *
 * The behaviour under test is the direction of the arrows: a read never fetches,
 * a second resolution of the same account never fetches, and a settled
 * `unavailable` never fetches again. Every one of those is a rate-limit budget
 * (#18) that this file exists to not spend.
 */

const db = getDb();
const NOW = new Date("2026-09-04T12:00:00.000Z");

async function pngBytes(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 9, g: 90, b: 140 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

/** A transport that always serves the same real PNG, and counts its calls. */
async function countingTransport() {
  const bytes = await pngBytes();
  return vi.fn<Transport>(async () => ({
    status: 200,
    location: null,
    body: (async function* one() {
      yield bytes;
    })(),
  }));
}

const failing: Transport = async () => ({
  status: 503,
  location: null,
  body: (async function* none() {})(),
});

beforeEach(async () => {
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
  // Resolution now spends rate-limit budget (#18), and these suites resolve far
  // more often in a few seconds than any real deployment would. Cleared per test
  // so a limit reached in one does not silently refuse resolution in the next —
  // which would look like a caching bug rather than a limit.
  await db.rateLimit.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
  await db.rateLimit.deleteMany();
});

describe("avatarKey", () => {
  it("case-folds, because a platform handle is one account either way", () => {
    expect(avatarKey("Mira-Builds")).toBe("mira-builds");
    expect(avatarLookupKey({ platform: "github", handle: "MIRA" })).toBe("github:mira");
  });
});

describe("ensureAvatar", () => {
  it("stores both sizes and marks the row ok", async () => {
    const transport = await countingTransport();
    const row = await ensureAvatar("github", "mira-builds", { now: NOW, transport });

    expect(row?.status).toBe("ok");
    expect(row?.contentType).toBe("image/webp");
    expect(row?.large?.byteLength).toBeGreaterThan(0);
    expect(row?.small?.byteLength).toBeGreaterThan(0);
    expect(row?.handle).toBe("mira-builds");
  });

  it("does not fetch again while the row is fresh", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    await ensureAvatar("github", "MIRA-BUILDS", { now: NOW, transport });

    // Three calls, one fetch — including the one that differs only in case.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the row has gone stale", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    await ensureAvatar("github", "mira-builds", { now: later, transport });

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("records a failure with its reason and counts the attempt", async () => {
    const row = await ensureAvatar("github", "mira-builds", { now: NOW, transport: failing });

    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toContain("503");
    expect(row?.attempts).toBe(1);
    expect(row?.large).toBeNull();
  });

  it("counts consecutive failures rather than resetting each time", async () => {
    await ensureAvatar("github", "mira-builds", { now: NOW, transport: failing });
    const second = await ensureAvatar("github", "mira-builds", {
      now: new Date(NOW.getTime() + RETRY_FAILED_AFTER_MS + 1),
      transport: failing,
    });
    expect(second?.attempts).toBe(2);
  });

  it("clears the failure and its count once a retry succeeds", async () => {
    await ensureAvatar("github", "mira-builds", { now: NOW, transport: failing });

    const transport = await countingTransport();
    const recovered = await ensureAvatar("github", "mira-builds", {
      now: new Date(NOW.getTime() + RETRY_FAILED_AFTER_MS + 1),
      transport,
    });

    expect(recovered?.status).toBe("ok");
    expect(recovered?.attempts).toBe(0);
    expect(recovered?.failureReason).toBeNull();
  });

  it("does not fetch for a platform that has no resolver", async () => {
    const transport = await countingTransport();
    const row = await ensureAvatar("tiktok", "halfbuilt", { now: NOW, transport });

    expect(row?.status).toBe("unavailable");
    expect(row?.failureReason).toContain("developer token");
    expect(transport).not.toHaveBeenCalled();
  });

  it("never fetches again for a settled unavailable", async () => {
    const transport = await countingTransport();
    await ensureAvatar("web", "example.com", { now: NOW, transport });
    await ensureAvatar("web", "example.com", {
      now: new Date(NOW.getTime() + 365 * 24 * 3_600_000),
      transport,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("writes nothing for a listing with no handle", async () => {
    const transport = await countingTransport();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A website listing carries an empty handle by design (#21), and the avatar
    // table requires a non-empty one — so this used to attempt a write the
    // schema refuses, on every single website purchase, and swallow the error.
    expect(await ensureAvatar("web", "", { now: NOW, transport })).toBeNull();

    expect(await db.avatar.count()).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-resolves anyway when forced", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    await ensureAvatar("github", "mira-builds", { now: NOW, transport, force: true });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than throwing when the write fails", async () => {
    const transport = await countingTransport();
    vi.spyOn(db.avatar, "upsert").mockRejectedValueOnce(new Error("connection lost"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // The webhook calls this. An exception here would turn a bad minute at an
    // avatar host into a purchase that did not record.
    await expect(
      ensureAvatar("github", "mira-builds", { now: NOW, transport }),
    ).resolves.toBeNull();
  });

  it("does not log the upstream response body on failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretish: Transport = async () => ({
      status: 500,
      location: null,
      body: (async function* body() {
        yield new TextEncoder().encode("INTERNAL STACK TRACE session=abc123");
      })(),
    });

    await ensureAvatar("github", "mira-builds", { now: NOW, transport: secretish });

    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("mira-builds");
    expect(logged).not.toContain("session=abc123");
  });
});

describe("isStale", () => {
  it("refreshes an ok row on the long cycle", () => {
    const at = (ms: number) => ({
      status: "ok" as const,
      resolvedAt: new Date(NOW.getTime() - ms),
    });
    expect(isStale(at(REFRESH_AFTER_MS - 1), NOW)).toBe(false);
    expect(isStale(at(REFRESH_AFTER_MS), NOW)).toBe(true);
  });

  it("retries a failure sooner than it refreshes a success", () => {
    expect(RETRY_FAILED_AFTER_MS).toBeLessThan(REFRESH_AFTER_MS);
  });

  it("never revisits an unavailable", () => {
    const ancient = { status: "unavailable" as const, resolvedAt: new Date(0) };
    expect(isStale(ancient, NOW)).toBe(false);
  });
});

describe("readAvatars", () => {
  it("returns only rows that actually have bytes", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    await ensureAvatar("github", "broken", { now: NOW, transport: failing });
    await ensureAvatar("tiktok", "halfbuilt", { now: NOW, transport });

    const map = await readAvatars([
      { platform: "github", handle: "Mira-Builds" },
      { platform: "github", handle: "broken" },
      { platform: "tiktok", handle: "halfbuilt" },
    ]);

    // A failed row and an unavailable row are both indistinguishable from no row
    // at all as far as rendering is concerned: all three take the placeholder.
    expect([...map.keys()]).toEqual(["github:mira-builds"]);
    expect(map.get("github:mira-builds")?.version).toBeGreaterThan(0);
  });

  it("makes no query at all for an empty board", async () => {
    const findMany = vi.spyOn(db.avatar, "findMany");
    expect((await readAvatars([])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("never resolves — a read cannot cause a fetch", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    transport.mockClear();

    await readAvatars([{ platform: "github", handle: "mira-builds" }]);
    await readAvatars([{ platform: "github", handle: "nobody-at-all" }]);

    expect(transport).not.toHaveBeenCalled();
  });
});

describe("refreshStaleAvatars", () => {
  async function seedLive(handle: string) {
    const quote = quoteForQueue(1, 3, 0);
    await db.purchase.create({
      data: {
        slot: 1,
        durationH: 3,
        handle,
        platform: "github",
        targetUrl: `https://github.com/${handle}`,
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        status: "queued",
      },
    });
  }

  it("refreshes a stale row for an account still on the board", async () => {
    const transport = await countingTransport();
    await seedLive("mira-builds");
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    transport.mockClear();

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    const summary = await refreshStaleAvatars(later, { transport });

    expect(summary).toEqual({ considered: 1, resolved: 1, failed: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("leaves a fresh row alone", async () => {
    const transport = await countingTransport();
    await seedLive("mira-builds");
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    transport.mockClear();

    const summary = await refreshStaleAvatars(NOW, { transport });
    expect(summary.considered).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("ignores accounts whose rentals are over", async () => {
    const transport = await countingTransport();
    // Resolved once, but the rental has since ended: nothing will render it, so
    // refreshing it spends someone else's rate limit for nothing.
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    transport.mockClear();

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    expect((await refreshStaleAvatars(later, { transport })).considered).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does nothing at all when the board and queue are empty", async () => {
    const transport = await countingTransport();
    expect(await refreshStaleAvatars(NOW, { transport })).toEqual({
      considered: 0,
      resolved: 0,
      failed: 0,
    });
  });

  it("stops at its time budget, not only at its row count", async () => {
    const slow: Transport = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 503, location: null, body: (async function* none() {})() };
    };

    for (const handle of ["one", "two", "three", "four", "five", "six"]) {
      await seedLive(handle);
      await ensureAvatar("github", handle, { now: NOW, transport: await countingTransport() });
    }

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    const summary = await refreshStaleAvatars(later, { transport: slow, budgetMs: 60 });

    // A row count alone does not bound the time: twenty rows each timing out is
    // eighty seconds inside one scheduled request. Whatever is not reached is
    // still stale, and the next tick starts with it.
    expect(summary.considered).toBe(6);
    expect(summary.resolved + summary.failed).toBeLessThan(6);
  });

  it("bounds how many it touches in one pass", async () => {
    const transport = await countingTransport();
    for (const handle of ["one", "two", "three", "four"]) {
      await seedLive(handle);
      await ensureAvatar("github", handle, { now: NOW, transport });
    }
    transport.mockClear();

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    const summary = await refreshStaleAvatars(later, { transport, limit: 2 });

    // A job that times out half way refreshes the same first rows forever.
    expect(summary.considered).toBe(2);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("the resolution limit (#18)", () => {
  /** Spends the whole avatar budget, so the next resolution is refused. */
  async function exhaust(now: Date) {
    const policy = serverConfig().RATE_LIMIT_AVATAR;
    for (let i = 0; i < policy.burst; i += 1) {
      await consume({ bucket: "avatar", identity: "github", policy, now });
    }
  }

  it("does not spend budget on a cache hit", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });

    const afterFirst = await db.rateLimit.findFirst();
    expect(afterFirst).not.toBeNull();

    for (let i = 0; i < 30; i += 1) {
      await ensureAvatar("github", "mira-builds", { now: NOW, transport });
    }

    // The issue is explicit that only actual upstream fetches consume limit.
    // Otherwise a popular board burns the provider's budget on requests it never
    // made — and the busier TopNow got, the sooner avatars would stop resolving.
    expect(transport).toHaveBeenCalledTimes(1);
    const afterHits = await db.rateLimit.findFirst();
    expect(afterHits!.tat.getTime()).toBe(afterFirst!.tat.getTime());
  });

  it("declines to fetch once the budget is spent", async () => {
    await exhaust(NOW);
    const transport = await countingTransport();

    expect(await ensureAvatar("github", "mira-builds", { now: NOW, transport })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not record the refusal as a fact about the account", async () => {
    await exhaust(NOW);
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });

    // A `failed` row here would burn an attempt and cache a reason that says
    // nothing about the handle — and `isStale` would then hold the account back
    // from being resolved for the retry interval, over a limit that was ours.
    expect(await db.avatar.count()).toBe(0);
  });

  it("keeps serving the cached row while resolution is held back", async () => {
    const transport = await countingTransport();
    await ensureAvatar("github", "mira-builds", { now: NOW, transport });

    const stale = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    await exhaust(stale);
    transport.mockClear();

    const row = await ensureAvatar("github", "mira-builds", { now: stale, transport });
    // A limit on refreshing must not take a working avatar off the board.
    expect(row?.status).toBe("ok");
    expect(row?.large?.byteLength).toBeGreaterThan(0);
    expect(transport).not.toHaveBeenCalled();
  });
});
