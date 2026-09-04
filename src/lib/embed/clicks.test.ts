import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { quoteForQueue } from "@/lib/pricing";

import { clickThroughHref, recordClick } from "./clicks";

const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";

/**
 * Click counting (#20).
 *
 * The rule the issue sets is that a printed count must be real. Clicks are the
 * one engagement figure TopNow measures itself, so these tests are about it
 * being an honest count — and about counting never being allowed to cost a
 * buyer the traffic they paid for.
 */

const db = getDb();

async function seedListing(targetUrl = "https://github.com/mira-builds") {
  const quote = quoteForQueue(1, 3, 0);
  return db.purchase.create({
    data: {
      slot: 1,
      durationH: 3,
      handle: "mira-builds",
      platform: "github",
      targetUrl,
      tagline: "Open-source invoicing for freelancers who hate invoicing.",
      priceHrCents: quote.askHrCents,
      totalPaidCents: quote.totalCents,
      status: "queued",
    },
  });
}

beforeEach(async () => {
  await db.purchase.deleteMany();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.purchase.deleteMany();
});

describe("recordClick", () => {
  it("counts a click and returns where to send the visitor", async () => {
    const listing = await seedListing();

    expect(await recordClick(listing.id, CHROME)).toBe("https://github.com/mira-builds");
    expect((await db.purchase.findUnique({ where: { id: listing.id } }))?.clicks).toBe(1);
  });

  it("counts each click rather than only the first", async () => {
    const listing = await seedListing();
    for (let i = 0; i < 5; i += 1) await recordClick(listing.id, CHROME);

    expect((await db.purchase.findUnique({ where: { id: listing.id } }))?.clicks).toBe(5);
  });

  it("starts at zero, not at something friendlier", async () => {
    const listing = await seedListing();
    expect(listing.clicks).toBe(0);
  });

  it("returns nothing for a listing that does not exist", async () => {
    expect(await recordClick("00000000-0000-4000-8000-000000000000", CHROME)).toBeNull();
  });

  it("still forwards the visitor when counting fails", async () => {
    const listing = await seedListing();
    vi.spyOn(db.purchase, "update").mockRejectedValueOnce(new Error("write failed"));

    // A broken counter must not become a broken link. The buyer paid for the
    // traffic; the number is ours to lose.
    expect(await recordClick(listing.id, CHROME)).toBe("https://github.com/mira-builds");
  });

  it("forwards a bot but does not count it", async () => {
    const listing = await seedListing();

    // Clicks are the one engagement figure the product prints, so it is the one
    // that must not be inflated. A preview unfurler following the link is not a
    // person clicking it — but it still gets where it was going.
    expect(await recordClick(listing.id, "Slackbot-LinkExpanding 1.0")).toBe(
      "https://github.com/mira-builds",
    );
    expect((await db.purchase.findUnique({ where: { id: listing.id } }))?.clicks).toBe(0);
  });

  it("does not count a request with no user agent", async () => {
    const listing = await seedListing();
    // Same rule the visit counter uses: browsers send one, and things that do
    // not are usually not people. It errs downward, which is the safe direction.
    expect(await recordClick(listing.id, null)).toBe("https://github.com/mira-builds");
    expect((await db.purchase.findUnique({ where: { id: listing.id } }))?.clicks).toBe(0);
  });

  it("reads the destination from the row, never from a caller", async () => {
    // The whole reason this is a lookup rather than a parameter: a redirector
    // that forwards to a URL handed to it is an open redirect, and an open
    // redirect on a domain people are asked to trust with a payment is worth
    // more to a phisher than the leaderboard is to anyone.
    const listing = await seedListing("https://example.com/real-target");
    expect(await recordClick(listing.id, CHROME)).toBe("https://example.com/real-target");
  });
});

describe("clickThroughHref", () => {
  it("points at our own route, carrying only the listing id", () => {
    const href = clickThroughHref("11111111-2222-4333-8444-555555555555");
    expect(href).toBe("/api/go/11111111-2222-4333-8444-555555555555");
    // Nothing resembling a destination in the URL.
    expect(href).not.toContain("http");
  });
});
