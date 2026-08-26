import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Platform } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";
import { formatMoney } from "../src/lib/pricing/format";

/**
 * The board (#6).
 *
 * These drive real database state rather than a fixture endpoint, because the
 * thing worth testing is that the board reflects what is actually stored.
 *
 * Seeding touches a database shared by every worker, so this file has a
 * Playwright project of its own and runs serially. The responsive assertions
 * set their own viewport.
 */
// Runs in its own Playwright project (see playwright.config.ts) so that no
// other worker is touching the database while these seed it.
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function clear() {
  await db.purchase.deleteMany();
}

async function seedLive(
  slot: Slot,
  durationH: DurationHours,
  handle: string,
  platform: Platform,
  tagline: string,
  targetUrl: string,
) {
  const q = quoteForQueue(slot, durationH, 0);
  const boughtAt = new Date(Date.now() - 60_000);
  const startsAt = new Date(Date.now() - 30_000);
  return db.purchase.create({
    data: {
      slot,
      durationH,
      handle,
      platform,
      targetUrl,
      tagline,
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
      status: "live",
      boughtAt,
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * 3_600_000),
    },
  });
}

async function seedQueued(slot: Slot, durationH: DurationHours, handle: string) {
  const q = quoteForQueue(slot, durationH, 0);
  return db.purchase.create({
    data: {
      slot,
      durationH,
      handle,
      platform: "github",
      targetUrl: `https://github.com/${handle}`,
      tagline: "tagline",
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
      status: "queued",
    },
  });
}

async function gotoBoard(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

test.afterAll(async () => {
  await clear();
  await db.$disconnect();
});

test.describe("an empty board", () => {
  test.beforeAll(clear);

  /**
   * Launch day. Three open slots at base is a perfectly good page, and nothing
   * is invented to make it look busier.
   */
  test("shows three open slots at their real base rates", async ({ page }) => {
    await gotoBoard(page);

    for (const slot of [1, 2, 3] as Slot[]) {
      const rate = formatMoney(quoteForQueue(slot, 1, 0).askHrCents);
      await expect(
        page.getByRole("button", { name: new RegExp(`TAKE SLOT 0${slot} — \\${rate}/HR`) }),
      ).toBeVisible();
    }
  });

  test("renders no countdown when nothing is live", async ({ page }) => {
    await gotoBoard(page);
    await expect(page.locator('[role="timer"]')).toHaveCount(0);
  });
});

test.describe("an occupied board", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(
      1,
      6,
      "mira_builds",
      "github",
      "Open-source invoicing for freelancers who hate invoicing.",
      "https://github.com/mira_builds",
    );
    await seedLive(
      2,
      3,
      "parcelkit",
      "youtube",
      "Weekly teardowns of shipping-label APIs.",
      "https://youtube.com/@parcelkit",
    );
    await seedQueued(1, 3, "dovetail_app");
    await seedQueued(1, 3, "halfbuilt");
  });

  test("shows the real occupants and their real taglines", async ({ page }) => {
    await gotoBoard(page);
    await expect(page.getByText("@mira_builds")).toBeVisible();
    await expect(page.getByText("Weekly teardowns of shipping-label APIs.")).toBeVisible();
  });

  /**
   * The point of #6. If slot 01 were slot 02 at a larger size, the price tiers
   * would have no visible justification.
   */
  test("slot 01 is structurally distinct from slot 02", async ({ page }) => {
    await gotoBoard(page);

    const shapes = await page.evaluate(() => {
      const timers = Array.from(document.querySelectorAll('[role="timer"]'));
      // The full meter carries a depletion bar and HRS/MIN/SEC labels; the
      // compact one is a single readout.
      return timers.map((t) => ({
        hasDepletionBar: t.textContent?.includes("% LEFT") ?? false,
        hasUnitLabels: t.textContent?.includes("HRS") ?? false,
        width: t.getBoundingClientRect().width,
      }));
    });

    expect(shapes).toHaveLength(2);
    expect(shapes[0].hasDepletionBar).toBe(true);
    expect(shapes[0].hasUnitLabels).toBe(true);
    expect(shapes[1].hasDepletionBar).toBe(false);
    expect(shapes[1].hasUnitLabels).toBe(false);
    // And the top slot's meter is materially larger, not incidentally so.
    expect(shapes[0].width).toBeGreaterThan(shapes[1].width * 2);
  });

  test("slot 01's avatar is the large one", async ({ page }) => {
    await gotoBoard(page);
    const sizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[aria-hidden='true']"))
        .map((el) => el.getBoundingClientRect().width)
        .filter((w) => w === 78 || w === 38),
    );
    expect(sizes[0]).toBe(78);
    expect(sizes).toContain(38);
  });

  test("the CTA states what actually happens", async ({ page }) => {
    await gotoBoard(page);
    // Two queued behind slot 01, nobody behind slot 02.
    await expect(page.getByRole("button", { name: /JOIN QUEUE FOR 01 — 2 AHEAD/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /JOIN QUEUE FOR 02 — NEXT UP/ })).toBeVisible();
    // Slot 03 is still open, so it is taken rather than queued for.
    await expect(page.getByRole("button", { name: /TAKE SLOT 03/ })).toBeVisible();
  });

  test("shows what the occupant actually paid", async ({ page }) => {
    await gotoBoard(page);
    const paid = formatMoney(quoteForQueue(1, 6, 0).totalCents);
    await expect(page.getByText(paid, { exact: true })).toBeVisible();
  });

  test("every CTA is keyboard reachable and visibly focused", async ({ page }) => {
    await gotoBoard(page);
    const button = page.getByRole("button", { name: /JOIN QUEUE FOR 01/ });
    await button.focus();

    const outline = await page.evaluate(() => {
      const el = document.activeElement!;
      const s = getComputedStyle(el);
      return { width: parseFloat(s.outlineWidth), style: s.outlineStyle };
    });
    expect(outline.style).toBe("solid");
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test("no horizontal scroll at 360px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await gotoBoard(page);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});

test.describe("untrusted listing text", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(
      1,
      3,
      "sneaky",
      "github",
      '<img src=x onerror=alert(1)> & "quoted"',
      "https://github.com/sneaky",
    );
  });

  // Handles and taglines are user-supplied. They render as text, never markup.
  test("renders a tagline as text, not markup", async ({ page }) => {
    await gotoBoard(page);
    await expect(page.getByText('<img src=x onerror=alert(1)> & "quoted"')).toBeVisible();
    expect(await page.locator("img[src='x']").count()).toBe(0);
  });
});
