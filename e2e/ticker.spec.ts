import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";

/**
 * The activity ticker (#16).
 *
 * Every item has to trace to a real row. So the seeding here is deliberately
 * plain — rows with real timestamps — and the assertions are mostly about what
 * is *not* on screen: no welcome, no filler, and nothing at all when the board
 * has not been bought.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const HOUR = 3_600_000;

async function clear() {
  await db.visit.deleteMany();
  await db.askSample.deleteMany();
  await db.embed.deleteMany();
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
}

async function seedPurchase(
  slot: Slot,
  durationH: DurationHours,
  handle: string,
  { boughtAgo, live }: { boughtAgo: number; live?: boolean },
) {
  const quote = quoteForQueue(slot, durationH, 0);
  const boughtAt = new Date(Date.now() - boughtAgo);
  const startsAt = live ? boughtAt : null;

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
      status: live ? "live" : "queued",
      boughtAt,
      startsAt,
      endsAt: startsAt ? new Date(startsAt.getTime() + durationH * HOUR) : null,
    },
  });
}

async function seedSamples(slot: Slot, asks: number[]) {
  const base = quoteForQueue(slot, 1, 0).askHrCents;
  const anchor = Math.floor(Date.now() / HOUR) * HOUR;

  await db.askSample.createMany({
    data: asks.map((askHrCents, index) => ({
      slot,
      hour: new Date(anchor - (asks.length - index) * HOUR),
      askHrCents,
      baseHrCents: base,
      queuedHours: askHrCents === base ? 0 : 6,
    })),
  });
}

function ticker(page: Page) {
  return page.getByRole("region", { name: "Recent activity" });
}

/** Only the copy a reader actually hears — the duplicate half is hidden. */
function items(page: Page) {
  return ticker(page).locator("ul:not([aria-hidden='true']) li");
}

/**
 * The items matching a phrase, in the visible copy only.
 *
 * Scoped rather than searched page-wide because the seamless marquee renders the
 * same events twice; asserting on a count also proves the strip is not repeating
 * an event within a single copy.
 */
function saying(page: Page, phrase: RegExp) {
  return items(page).filter({ hasText: phrase });
}

test.describe("an empty board", () => {
  test.beforeAll(clear);

  test("says nothing has happened, and invents nothing to fill the strip", async ({ page }) => {
    await page.goto("/");
    await expect(ticker(page)).toBeVisible();

    await expect(ticker(page).locator("[data-ticker-empty]")).toHaveText(
      "Nothing has happened on the board yet.",
    );
    await expect(items(page)).toHaveCount(0);

    // No welcome, no tip, no heartbeat — the failure modes the issue names.
    await expect(ticker(page).getByText(/welcome|tip:|did you know|loading/i)).toHaveCount(0);
  });
});

test.describe("real transitions", () => {
  test.beforeAll(async () => {
    await clear();
    await seedPurchase(1, 6, "mira-builds", { boughtAgo: 2 * HOUR, live: true });
    await seedPurchase(2, 3, "parcelkit", { boughtAgo: HOUR });
  });

  test("reports a purchase going live and one joining a queue", async ({ page }) => {
    await page.goto("/");
    await expect(saying(page, /went live on slot 01/)).toHaveCount(1);
    await expect(saying(page, /joined the queue for slot 02/)).toHaveCount(1);
  });

  test("names the handle from the row, as its own element", async ({ page }) => {
    await page.goto("/");
    // Kept a value rather than folded into a sentence, which is what keeps user
    // content content.
    await expect(items(page).getByText("@mira-builds").first()).toBeVisible();
  });

  test("stamps every item with when it actually happened", async ({ page }) => {
    await page.goto("/");
    const stamps = await items(page)
      .locator("[data-numeric]")
      .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim() ?? ""));

    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(stamp).toMatch(/\d/);
  });

  test("puts the most recent first", async ({ page }) => {
    await page.goto("/");
    const first = await items(page).first().textContent();
    // parcelkit was bought an hour ago; mira-builds two hours ago.
    expect(first).toContain("parcelkit");
  });
});

test.describe("price moves come from the samples", () => {
  test.beforeAll(async () => {
    await clear();
    const base = quoteForQueue(1, 1, 0).askHrCents;
    // Flat, then a move, then back. Three samples, exactly two transitions.
    await seedSamples(1, [base, Math.round(base * 1.5), base]);
  });

  test("reports the move and the return, and nothing in between", async ({ page }) => {
    await page.goto("/");
    await expect(saying(page, /slot 01 moved to 1\.50× base/)).toHaveCount(1);
    await expect(saying(page, /slot 01 back to base/)).toHaveCount(1);
    // Three samples, two changes. The first has no predecessor to differ from.
    await expect(items(page)).toHaveCount(2);
  });

  test("says nothing at all about a slot that has not moved", async ({ page }) => {
    await clear();
    const base = quoteForQueue(2, 1, 0).askHrCents;
    await seedSamples(2, [base, base, base, base, base, base]);

    await page.goto("/");
    // Six hours of the same price is six hours of nothing happening.
    await expect(ticker(page).locator("[data-ticker-empty]")).toBeVisible();
  });
});

test.describe("presentation", () => {
  test.beforeAll(async () => {
    await clear();
    await seedPurchase(1, 6, "mira-builds", { boughtAgo: 2 * HOUR, live: true });
  });

  test("is a labelled list, not an interrupting live region", async ({ page }) => {
    await page.goto("/");
    await expect(ticker(page)).toBeVisible();

    // The strip changes only on a fresh render, so a live region would be one
    // that never fires.
    await expect(ticker(page).locator("[aria-live='assertive']")).toHaveCount(0);
    await expect(items(page).first()).toBeVisible();
  });

  test("hides the duplicated half from assistive tech", async ({ page }) => {
    await page.goto("/");
    // The seamless marquee needs two copies; a reader should hear one.
    const visibleLists = ticker(page).locator("ul:not([aria-hidden='true'])");
    await expect(visibleLists).toHaveCount(1);
  });

  test("does not animate under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const state = await ticker(page)
      .locator("[data-ticker] > div")
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return { name: style.animationName, duration: style.animationDuration };
      });

    // Either no animation is attached, or the stylesheet has neutralised it.
    const stopped = state.name === "none" || Number.parseFloat(state.duration) < 0.05;
    expect(stopped).toBe(true);

    // And it presents as a static list rather than a frozen marquee showing
    // half its content: the duplicate copy is display:none, so it is out of the
    // layout and out of the accessibility tree.
    await expect(ticker(page).locator("ul:visible")).toHaveCount(1);
    await expect(items(page).first()).toBeVisible();
  });

  test("is legible at 360px without pushing the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(items(page).first()).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });

  test("does not truncate a handle into something ambiguous", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");

    const handle = items(page).getByText("@mira-builds").first();
    // The strip scrolls rather than clipping: the whole handle is in the DOM
    // and none of it is replaced by an ellipsis.
    await expect(handle).toHaveText("@mira-builds");
  });
});
