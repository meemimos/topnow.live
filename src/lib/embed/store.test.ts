import sharp from "sharp";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";
import type { Transport } from "@/lib/fetch/net";
import { consume } from "@/lib/limit/limiter";
import { quoteForQueue } from "@/lib/pricing";

import { REFRESH_AFTER_MS, RETRY_FAILED_AFTER_MS } from "./constants";
import { ensureEmbed, isStale, readEmbed, refreshStaleEmbeds } from "./store";

/**
 * The embed cache (#20).
 *
 * Same rule as the avatar cache, and the same thing being proved: a read never
 * resolves, a repeat never refetches, and a settled negative is never asked
 * again. The last of those is what the issue means by "cache negative results
 * too".
 */

const db = getDb();
const NOW = new Date("2026-09-04T12:00:00.000Z");
const POST = "https://www.youtube.com/watch?v=abc123";

const HTML =
  '<iframe width="200" height="113" src="https://www.youtube.com/embed/abc123"></iframe>';

async function jpegBytes(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 480, height: 270, channels: 3, background: { r: 30, g: 60, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

async function workingTransport() {
  const thumb = await jpegBytes();
  return vi.fn<Transport>(async (url) => {
    if (url.hostname === "i.ytimg.com") {
      return {
        status: 200,
        location: null,
        body: (async function* one() {
          yield thumb;
        })(),
      };
    }
    return {
      status: 200,
      location: null,
      body: (async function* one() {
        yield new TextEncoder().encode(
          JSON.stringify({
            html: HTML,
            title: "Open-source invoicing, explained",
            author_name: "parcelkit",
            thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
          }),
        );
      })(),
    };
  });
}

const failing: Transport = async () => ({
  status: 500,
  location: null,
  body: (async function* none() {})(),
});

const deleted: Transport = async () => ({
  status: 404,
  location: null,
  body: (async function* none() {})(),
});

beforeEach(async () => {
  await db.embed.deleteMany();
  await db.purchase.deleteMany();
  // Resolution now spends rate-limit budget (#18), and these suites resolve far
  // more often in a few seconds than any real deployment would. Cleared per test
  // so a limit reached in one does not silently refuse resolution in the next —
  // which would look like a caching bug rather than a limit.
  await db.rateLimit.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.embed.deleteMany();
  await db.purchase.deleteMany();
  await db.rateLimit.deleteMany();
});

describe("ensureEmbed", () => {
  it("stores a resolved post", async () => {
    const transport = await workingTransport();
    const row = await ensureEmbed("youtube", POST, { now: NOW, transport });

    expect(row?.status).toBe("ok");
    expect(row?.iframeSrc).toBe("https://www.youtube.com/embed/abc123");
    expect(row?.title).toBe("Open-source invoicing, explained");
    expect(row?.thumbnail?.byteLength).toBeGreaterThan(0);
  });

  it("does not ask again while the row is fresh", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    await ensureEmbed("youtube", POST, { now: NOW, transport });
    expect(transport).not.toHaveBeenCalled();
  });

  it("treats two links to the same post as one row", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    // Same video, different campaign. One post, one row, one request.
    await ensureEmbed("youtube", `${POST}&utm_source=twitter&si=xyz`, { now: NOW, transport });

    expect(transport).not.toHaveBeenCalled();
    expect(await db.embed.count()).toBe(1);
  });

  it("caches a deleted post and never asks about it again", async () => {
    const row = await ensureEmbed("youtube", POST, { now: NOW, transport: deleted });
    expect(row?.status).toBe("unavailable");

    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, {
      now: new Date(NOW.getTime() + 365 * 24 * 3_600_000),
      transport,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("retries a transient failure on its own slower cycle", async () => {
    const first = await ensureEmbed("youtube", POST, { now: NOW, transport: failing });
    expect(first?.status).toBe("failed");
    expect(first?.attempts).toBe(1);

    const transport = await workingTransport();
    const recovered = await ensureEmbed("youtube", POST, {
      now: new Date(NOW.getTime() + RETRY_FAILED_AFTER_MS + 1),
      transport,
    });

    expect(recovered?.status).toBe("ok");
    expect(recovered?.attempts).toBe(0);
    expect(recovered?.failureReason).toBeNull();
  });

  it("keeps nothing renderable on a row that stopped resolving", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });

    const gone = await ensureEmbed("youtube", POST, {
      now: new Date(NOW.getTime() + REFRESH_AFTER_MS + 1),
      transport: deleted,
    });

    // Serving yesterday's frame behind today's "unavailable" would be showing a
    // post the provider has since said is not there.
    expect(gone?.status).toBe("unavailable");
    expect(gone?.iframeSrc).toBeNull();
    expect(gone?.thumbnail).toBeNull();
    expect(gone?.title).toBeNull();
  });

  it("returns null for a URL that does not validate, without touching the cache", async () => {
    const transport = await workingTransport();
    expect(
      await ensureEmbed("youtube", "https://www.youtube.com/@parcelkit", { now: NOW, transport }),
    ).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect(await db.embed.count()).toBe(0);
  });

  it("returns null rather than throwing when the write fails", async () => {
    const transport = await workingTransport();
    vi.spyOn(db.embed, "upsert").mockRejectedValueOnce(new Error("connection lost"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // The webhook calls this. An exception here would cost a purchase.
    await expect(ensureEmbed("youtube", POST, { now: NOW, transport })).resolves.toBeNull();
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

  it("never revisits an unavailable, however old", () => {
    expect(isStale({ status: "unavailable", resolvedAt: new Date(0) }, NOW)).toBe(false);
  });
});

describe("readEmbed", () => {
  it("returns nothing for a listing with no post", async () => {
    expect(await readEmbed({ platform: "youtube", postUrl: null })).toBeNull();
    expect(await readEmbed(null)).toBeNull();
  });

  it("returns nothing when the post has not resolved", async () => {
    await ensureEmbed("youtube", POST, { now: NOW, transport: failing });
    // A failed row and no row at all look identical to the board, which is what
    // gives slot 01 one branch to write instead of four.
    expect(await readEmbed({ platform: "youtube", postUrl: POST })).toBeNull();
  });

  it("returns a renderable embed once it has", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });

    const embed = await readEmbed({ platform: "youtube", postUrl: POST });
    expect(embed?.iframeSrc).toBe("https://www.youtube.com/embed/abc123");
    expect(embed?.hasThumbnail).toBe(true);
    expect(embed?.thumbnailVersion).toBeGreaterThan(0);
  });

  it("never resolves — a read cannot cause a fetch", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    await readEmbed({ platform: "youtube", postUrl: POST });
    await readEmbed({ platform: "youtube", postUrl: "https://www.youtube.com/watch?v=never" });

    expect(transport).not.toHaveBeenCalled();
  });

  it("hands back no markup at all, only a URL", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });

    const embed = await readEmbed({ platform: "youtube", postUrl: POST });
    expect(JSON.stringify(embed)).not.toContain("<iframe");
  });
});

describe("refreshStaleEmbeds", () => {
  async function seedQueued(postUrl: string | null) {
    const quote = quoteForQueue(1, 3, 0);
    await db.purchase.create({
      data: {
        slot: 1,
        durationH: 3,
        handle: "parcelkit",
        platform: "youtube",
        targetUrl: "https://youtube.com/@parcelkit",
        postUrl,
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        status: "queued",
      },
    });
  }

  it("refreshes a stale embed for a listing still on the board", async () => {
    const transport = await workingTransport();
    await seedQueued(POST);
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    const summary = await refreshStaleEmbeds(new Date(NOW.getTime() + REFRESH_AFTER_MS + 1), {
      transport,
    });
    expect(summary).toEqual({ considered: 1, resolved: 1, failed: 0, deferred: 0 });
  });

  it("leaves a fresh row alone", async () => {
    const transport = await workingTransport();
    await seedQueued(POST);
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    expect((await refreshStaleEmbeds(NOW, { transport })).considered).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("ignores posts whose rentals are over", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    transport.mockClear();

    const later = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    expect((await refreshStaleEmbeds(later, { transport })).considered).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does nothing when no live listing carries a post", async () => {
    const transport = await workingTransport();
    await seedQueued(null);
    expect(await refreshStaleEmbeds(NOW, { transport })).toEqual({
      considered: 0,
      resolved: 0,
      failed: 0,
      deferred: 0,
    });
  });
});

describe("the resolution limit (#18)", () => {
  /** Spends the whole oEmbed budget for the platform. */
  async function exhaust(now: Date) {
    const policy = serverConfig().RATE_LIMIT_EMBED;
    for (let i = 0; i < policy.burst; i += 1) {
      await consume({ bucket: "embed", identity: "youtube", policy, now });
    }
  }

  it("does not spend budget on a cache hit", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });
    const afterFirst = await db.rateLimit.findFirst();

    for (let i = 0; i < 30; i += 1) {
      await ensureEmbed("youtube", POST, { now: NOW, transport });
    }

    const afterHits = await db.rateLimit.findFirst();
    expect(afterHits!.tat.getTime()).toBe(afterFirst!.tat.getTime());
  });

  it("declines to ask the provider once the budget is spent", async () => {
    await exhaust(NOW);
    const transport = await workingTransport();

    expect(await ensureEmbed("youtube", POST, { now: NOW, transport })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not cache the refusal as a fact about the post", async () => {
    await exhaust(NOW);
    await ensureEmbed("youtube", POST, { now: NOW, transport: await workingTransport() });

    // A `failed` row would hold the post back for the retry interval over a
    // limit that was TopNow's rather than the provider's.
    expect(await db.embed.count()).toBe(0);
  });

  it("keeps rendering the cached embed while resolution is held back", async () => {
    const transport = await workingTransport();
    await ensureEmbed("youtube", POST, { now: NOW, transport });

    const stale = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    await exhaust(stale);
    transport.mockClear();

    const row = await ensureEmbed("youtube", POST, { now: stale, transport });
    expect(row?.status).toBe("ok");
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("a post that was never resolved even once", () => {
  async function seedQueued(postUrl: string | null) {
    const quote = quoteForQueue(1, 3, 0);
    await db.purchase.create({
      data: {
        slot: 1,
        durationH: 3,
        handle: "parcelkit",
        platform: "youtube",
        targetUrl: "https://youtube.com/@parcelkit",
        postUrl,
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        status: "queued",
      },
    });
  }

  it("is picked up by the refresh, even though it has no row", async () => {
    // Same hole the avatar cache had. The first attempt is in the Stripe
    // webhook; a deferral there writes no row, and a refresher scanning only
    // `embed` would never come back — slot 01 would render as a profile card
    // for the whole rental with nothing recording why.
    const transport = await workingTransport();
    await seedQueued(POST);

    const summary = await refreshStaleEmbeds(NOW, { transport });

    expect(summary).toMatchObject({ considered: 1, resolved: 1, failed: 0, deferred: 0 });
    expect((await db.embed.findMany())[0]?.status).toBe("ok");
  });

  it("does not re-ask about a post already settled as unavailable", async () => {
    const transport = await workingTransport();
    await seedQueued(POST);
    await ensureEmbed("youtube", POST, { now: NOW, transport: failing });
    await db.embed.update({
      where: { postUrl: POST },
      data: { status: "unavailable", failureReason: "deleted", resolvedAt: NOW },
    });

    const summary = await refreshStaleEmbeds(new Date(NOW.getTime() + REFRESH_AFTER_MS + 1), {
      transport,
    });

    // A deleted post stays deleted. Treating a settled row as never-tried would
    // make every one of them an outbound request on every tick — which is the
    // rate-limit budget the negative cache exists to protect.
    expect(summary.considered).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports a throttled pass as deferred rather than resolved", async () => {
    const policy = serverConfig().RATE_LIMIT_EMBED;
    const transport = await workingTransport();
    await seedQueued(POST);
    await ensureEmbed("youtube", POST, { now: NOW, transport });

    const stale = new Date(NOW.getTime() + REFRESH_AFTER_MS + 1);
    for (let i = 0; i < policy.burst; i += 1) {
      await consume({ bucket: "embed", identity: "youtube", policy, now: stale });
    }
    transport.mockClear();

    const summary = await refreshStaleEmbeds(stale, { transport });

    expect(summary).toMatchObject({ considered: 1, resolved: 0, failed: 0, deferred: 1 });
    expect(transport).not.toHaveBeenCalled();
  });
});
