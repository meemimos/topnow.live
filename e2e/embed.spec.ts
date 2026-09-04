import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";

/**
 * The embedded post panel on slot 01 (#20).
 *
 * The rule this file exists for: **an embed that does not resolve degrades
 * silently to the profile card.** No error text, no empty frame, no layout jump.
 * So most of what follows forces a failure and then checks that slot 01 looks
 * like a slot that simply never had a post.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const POST = "https://www.youtube.com/watch?v=abc123";

/** Hosts the page must not touch before anyone presses play. */
const PROVIDER_HOSTS = ["youtube.com", "youtube-nocookie.com", "ytimg.com", "ggpht.com"];

async function clear() {
  await db.askSample.deleteMany();
  await db.embed.deleteMany();
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
}

async function thumbnailBytes() {
  return sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 20, g: 90, b: 60 } },
  })
    .webp()
    .toBuffer();
}

async function seedEmbed(overrides: Record<string, unknown> = {}) {
  return db.embed.create({
    data: {
      postUrl: POST,
      platform: "youtube",
      status: "ok",
      title: "Open-source invoicing, explained",
      authorName: "parcelkit",
      iframeSrc: "https://www.youtube-nocookie.com/embed/abc123",
      iframeWidth: 200,
      iframeHeight: 113,
      thumbnail: await thumbnailBytes(),
      thumbnailWidth: 640,
      resolvedAt: new Date(),
      ...overrides,
    },
  });
}

async function seedLive(
  slot: Slot,
  durationH: DurationHours,
  handle: string,
  postUrl: string | null = null,
) {
  const quote = quoteForQueue(slot, durationH, 0);
  const startsAt = new Date(Date.now() - 60_000);
  return db.purchase.create({
    data: {
      slot,
      durationH,
      handle,
      platform: "youtube",
      targetUrl: `https://youtube.com/@${handle}`,
      postUrl,
      tagline: "Open-source invoicing for freelancers who hate invoicing.",
      priceHrCents: quote.askHrCents,
      totalPaidCents: quote.totalCents,
      status: "live",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * 3_600_000),
    },
  });
}

function board(page: Page) {
  return page.getByRole("region", { name: "The board" });
}

function panel(page: Page) {
  return board(page).getByText("EMBEDDED POST");
}

test.describe("a post that resolved", () => {
  test.beforeAll(async () => {
    await clear();
    await seedEmbed();
    await seedLive(1, 6, "parcelkit", POST);
  });

  test("shows the panel with the post's real title and author", async ({ page }) => {
    await page.goto("/");
    await expect(panel(page)).toBeVisible();
    await expect(board(page).getByText("Open-source invoicing, explained")).toBeVisible();
    // The byline specifically. The handle and the link also say "parcelkit",
    // which is exactly why this targets the em dash the byline is written with.
    await expect(board(page).getByText("— parcelkit")).toBeVisible();
  });

  test("loads no provider frame until someone presses play", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

    await page.goto("/");
    await expect(panel(page)).toBeVisible();
    await page.waitForLoadState("networkidle");

    // A visitor who came to look at a leaderboard has not asked to be
    // introduced to YouTube.
    expect(board(page).locator("iframe")).toHaveCount(0);
    const offending = requested.filter((url) => PROVIDER_HOSTS.some((host) => url.includes(host)));
    expect(offending, `page requested ${offending.join(", ")}`).toEqual([]);
  });

  test("serves the thumbnail from our own origin", async ({ page }) => {
    await page.goto("/");
    const src = await board(page).locator("img").last().getAttribute("src");
    expect(src).toContain("/api/embed/");
    expect(new URL(src!, page.url()).origin).toBe(new URL(page.url()).origin);
  });

  test("mounts a sandboxed frame on play, and only then", async ({ page }) => {
    await page.goto("/");
    await board(page)
      .getByRole("button", { name: /PLAY POST/ })
      .click();

    const frame = board(page).locator("iframe");
    await expect(frame).toHaveCount(1);
    await expect(frame).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/abc123");

    const sandbox = await frame.getAttribute("sandbox");
    expect(sandbox).toContain("allow-scripts");
    // The pair `allow-scripts allow-same-origin` lets a frame remove its own
    // sandbox, which is the whole point of not granting the second one.
    expect(sandbox).not.toContain("allow-same-origin");
    expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  test("says what pressing play will do, before it is pressed", async ({ page }) => {
    await page.goto("/");
    await expect(
      board(page).getByText("LOADS FROM THE PLATFORM WHEN YOU PRESS PLAY"),
    ).toBeVisible();
  });
});

test.describe("counts are real or absent", () => {
  test.beforeAll(async () => {
    await clear();
    await seedEmbed();
    await seedLive(1, 6, "parcelkit", POST);
  });

  test("omits views entirely when the provider reported none", async ({ page }) => {
    await page.goto("/");
    await expect(panel(page)).toBeVisible();
    // None of YouTube, TikTok or Reddit put a view count in an oEmbed response,
    // so this row is simply not there. A zero would be a claim nobody made.
    await expect(board(page).getByText(/views/)).toHaveCount(0);
  });

  test("shows a click count that starts at the truth", async ({ page }) => {
    await page.goto("/");
    await expect(board(page).getByText("0 clicks")).toBeVisible();
  });

  test("counts a real click through our own redirect", async ({ page, request }) => {
    await page.goto("/");
    const href = await board(page)
      .getByRole("link", { name: /youtube.com/ })
      .getAttribute("href");
    expect(href).toMatch(/^\/api\/go\//);

    const response = await request.get(href!, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("https://youtube.com/@parcelkit");

    await page.reload();
    await expect(board(page).getByText("1 clicks")).toBeVisible();
  });

  test("shows the provider's view count when there actually is one", async ({ page }) => {
    await db.embed.updateMany({ where: { postUrl: POST }, data: { providerViews: 4126 } });
    await page.goto("/");
    await expect(board(page).getByText("4,126 views")).toBeVisible();
  });
});

/**
 * Every way an embed can fail to exist. In all of them slot 01 is a profile
 * card — complete, and never explaining itself.
 */
test.describe("silent degradation", () => {
  test.beforeEach(async () => {
    await clear();
  });

  async function expectProfileCardOnly(page: Page) {
    await page.goto("/");
    await expect(board(page)).toBeVisible();

    await expect(panel(page)).toHaveCount(0);
    await expect(board(page).locator("iframe")).toHaveCount(0);
    // No apology anywhere on the page.
    await expect(page.getByText(/could not load|unavailable|failed to load|error/i)).toHaveCount(0);
    // And the listing itself is still entirely there. `exact` because the link
    // text also ends in the handle, and the display name is the assertion.
    await expect(board(page).getByText("@parcelkit", { exact: true })).toBeVisible();
  }

  test("a listing with no post link", async ({ page }) => {
    await seedLive(1, 6, "parcelkit", null);
    await expectProfileCardOnly(page);
  });

  test("a post that has not resolved yet", async ({ page }) => {
    await seedLive(1, 6, "parcelkit", POST);
    await expectProfileCardOnly(page);
  });

  test("a post the provider says is gone", async ({ page }) => {
    await seedEmbed({
      status: "unavailable",
      iframeSrc: null,
      title: null,
      authorName: null,
      thumbnail: null,
      thumbnailWidth: null,
      failureReason: "post is not embeddable: returned 404",
    });
    await seedLive(1, 6, "parcelkit", POST);
    await expectProfileCardOnly(page);
  });

  test("a resolution that failed", async ({ page }) => {
    await seedEmbed({
      status: "failed",
      iframeSrc: null,
      title: null,
      authorName: null,
      thumbnail: null,
      thumbnailWidth: null,
      failureReason: "upstream returned 500",
    });
    await seedLive(1, 6, "parcelkit", POST);
    await expectProfileCardOnly(page);
  });

  test("a platform that has no post embed at all", async ({ page }) => {
    // GitHub is not a fallback here — the profile card is its normal state.
    const quote = quoteForQueue(1, 6, 0);
    const startsAt = new Date(Date.now() - 60_000);
    await db.purchase.create({
      data: {
        slot: 1,
        durationH: 6,
        handle: "parcelkit",
        platform: "github",
        targetUrl: "https://github.com/parcelkit",
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        status: "live",
        boughtAt: new Date(startsAt.getTime() - 60_000),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 6 * 3_600_000),
      },
    });
    await expectProfileCardOnly(page);
  });
});

test.describe("the thumbnail route", () => {
  test.beforeAll(async () => {
    await clear();
    await seedEmbed();
    await seedLive(1, 6, "parcelkit", POST);
  });

  test("serves webp with the same restrictive headers as an avatar", async ({ request }) => {
    const row = await db.embed.findFirstOrThrow({ select: { id: true } });
    const response = await request.get(`/api/embed/${row.id}/thumbnail`);

    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toBe("image/webp");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
  });

  test("404s for a malformed id and for a row with no thumbnail", async ({ request }) => {
    expect((await request.get("/api/embed/not-a-uuid/thumbnail")).status()).toBe(404);
    expect(
      (await request.get("/api/embed/00000000-0000-4000-8000-000000000000/thumbnail")).status(),
    ).toBe(404);
  });
});

test.describe("the redirect is not an open redirect", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(1, 6, "parcelkit", null);
  });

  test("ignores anything a caller puts in the query string", async ({ request }) => {
    const listing = await db.purchase.findFirstOrThrow({ select: { id: true } });
    const response = await request.get(`/api/go/${listing.id}?url=https://evil.example.com`, {
      maxRedirects: 0,
    });

    // The destination comes from the row. An open redirect on a domain people
    // are asked to trust with a payment is worth more to a phisher than the
    // leaderboard is to anyone.
    expect(response.headers()["location"]).toBe("https://youtube.com/@parcelkit");
  });

  test("404s for a listing that does not exist", async ({ request }) => {
    const response = await request.get("/api/go/00000000-0000-4000-8000-000000000000", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
  });
});

test.describe("at 360px", () => {
  test.beforeAll(async () => {
    await clear();
    await seedEmbed();
    await seedLive(1, 6, "parcelkit", POST);
  });

  test("the panel does not force the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(panel(page)).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });

  test("swapping the thumbnail for the frame does not move the page", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");

    const media = board(page).getByRole("button", { name: /PLAY POST/ });
    const before = await media.boundingBox();

    await media.click();
    const after = await board(page).locator("iframe").boundingBox();

    // The box is sized from the provider's own aspect ratio before anything
    // loads, which is what makes this hold.
    expect(after?.height).toBeCloseTo(before?.height ?? 0, 0);
  });
});
