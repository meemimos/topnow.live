import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";

/**
 * Avatars on the board (#19).
 *
 * The acceptance this file exists for: **no third-party avatar host appears in
 * any client-side request.** Everything else here is the shape of that promise —
 * same-origin URLs, our own bytes, and a designed placeholder wherever nothing
 * resolved.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/**
 * Hosts a listing's avatar could plausibly have been hotlinked from.
 *
 * The board must never reach any of them from the browser — that is what leaks a
 * visitor's IP to a third party on a page they did not ask to contact.
 */
const THIRD_PARTY_HOSTS = [
  "githubusercontent.com",
  "github.com",
  "ytimg.com",
  "ggpht.com",
  "cdninstagram.com",
  "fbcdn.net",
  "tiktokcdn.com",
  "redd.it",
  "redditstatic.com",
  "gravatar.com",
];

async function clear() {
  await db.askSample.deleteMany();
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
}

async function webpBytes(colour: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 156, height: 156, channels: 3, background: colour } })
    .webp()
    .toBuffer();
}

async function seedAvatar(handle: string) {
  return db.avatar.create({
    data: {
      platform: "github",
      handle: handle.toLowerCase(),
      status: "ok",
      contentType: "image/webp",
      large: await webpBytes({ r: 200, g: 30, b: 60 }),
      small: await webpBytes({ r: 30, g: 60, b: 200 }),
      sourceUrl: `https://github.com/${handle}.png?size=156`,
      resolvedAt: new Date(),
    },
  });
}

async function seedLive(slot: Slot, durationH: DurationHours, handle: string) {
  const quote = quoteForQueue(slot, durationH, 0);
  const startsAt = new Date(Date.now() - 60_000);
  return db.purchase.create({
    data: {
      slot,
      durationH,
      handle,
      platform: "github",
      targetUrl: `https://github.com/${handle}`,
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

/** Every URL the page asked the network for, including images. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  return urls;
}

function board(page: Page) {
  return page.getByRole("region", { name: "The board" });
}

test.describe("the board never contacts a third party", () => {
  test.beforeAll(async () => {
    await clear();
    await seedAvatar("mira-builds");
    await seedLive(1, 6, "mira-builds");
    await seedLive(2, 3, "parcelkit");
  });

  test("makes no request to any avatar host", async ({ page }) => {
    const urls = recordRequests(page);
    await page.goto("/");
    await expect(board(page)).toBeVisible();
    // Images are fetched after paint; give the page a moment to ask for them.
    await page.waitForLoadState("networkidle");

    const offending = urls.filter((url) => THIRD_PARTY_HOSTS.some((host) => url.includes(host)));
    expect(offending, `page requested ${offending.join(", ")}`).toEqual([]);
  });

  test("every image on the board is same-origin", async ({ page }) => {
    await page.goto("/");
    const sources = await board(page)
      .locator("img")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).src));

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(new URL(source).origin).toBe(new URL(page.url()).origin);
      expect(source).toContain("/api/avatar/");
    }
  });

  test("a github.com link in the markup is a link, not an image source", async ({ page }) => {
    await page.goto("/");
    // The target link genuinely points at github.com — that is the product. What
    // must not happen is the *browser* fetching from there without being asked.
    await expect(board(page).getByRole("link", { name: "github.com/mira-builds" })).toBeVisible();
  });
});

test.describe("the served bytes", () => {
  test.beforeAll(async () => {
    await clear();
    await seedAvatar("mira-builds");
    await seedLive(1, 6, "mira-builds");
  });

  test("come back as webp with restrictive headers", async ({ page, request }) => {
    await page.goto("/");
    const src = await board(page).locator("img").first().getAttribute("src");
    const response = await request.get(src!);

    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers["content-type"]).toBe("image/webp");
    // nosniff is what stops a browser second-guessing a content type on a path
    // whose input originated outside the product.
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  test("are the size the slot renders, not scaled down in the browser", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const src = await board(page).locator("img").first().getAttribute("src");
    const bytes = await (await request.get(src!)).body();

    // Slot 01's box is 78px; the file is that at 2x and nothing larger.
    const meta = await sharp(bytes).metadata();
    expect([meta.width, meta.height]).toEqual([156, 156]);
  });

  test("carry a version so the URL changes when the bytes do", async ({ page }) => {
    await page.goto("/");
    const src = await board(page).locator("img").first().getAttribute("src");
    expect(src).toMatch(/\?v=\d+$/);
  });

  test("404 for an unknown id, a bad size, and a malformed id", async ({ request }) => {
    const known = await db.avatar.findFirst({ select: { id: true } });

    expect((await request.get(`/api/avatar/${known!.id}/enormous`)).status()).toBe(404);
    expect((await request.get(`/api/avatar/not-a-uuid/large`)).status()).toBe(404);
    expect(
      (await request.get(`/api/avatar/00000000-0000-4000-8000-000000000000/large`)).status(),
    ).toBe(404);
  });

  test("serves no bytes for a row that failed to resolve", async ({ request }) => {
    const failed = await db.avatar.create({
      data: {
        platform: "github",
        handle: "brokenaccount",
        status: "failed",
        failureReason: "upstream returned 503",
        resolvedAt: new Date(),
      },
    });

    expect((await request.get(`/api/avatar/${failed.id}/large`)).status()).toBe(404);
  });
});

test.describe("the placeholder", () => {
  test.beforeAll(async () => {
    await clear();
    // A live listing with no avatar row at all — the launch-day state, and what
    // every platform without a resolver looks like.
    await seedLive(1, 6, "nobodyresolved");
  });

  test("renders instead of a broken image", async ({ page }) => {
    await page.goto("/");
    await expect(board(page).locator("img")).toHaveCount(0);
    // The handle is still there: the listing is complete, it just has no picture.
    await expect(board(page).getByText("@nobodyresolved")).toBeVisible();
  });

  test("occupies the same box the image would", async ({ page }) => {
    await page.goto("/");
    const placeholder = board(page).locator("[aria-hidden='true']").first();
    const size = await placeholder.boundingBox();
    // 78px for slot 01. The row must not reflow when an avatar later resolves.
    expect(size?.width).toBe(78);
    expect(size?.height).toBe(78);
  });
});

test.describe("at 360px", () => {
  test.beforeAll(async () => {
    await clear();
    await seedAvatar("mira-builds");
    await seedLive(1, 6, "mira-builds");
    await seedLive(2, 3, "parcelkit");
  });

  test("does not push the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(board(page)).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});
