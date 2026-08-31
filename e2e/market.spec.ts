import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { FLAT_WINDOW_CANDLES, MARKET_REVEAL_HOURS } from "../src/lib/market/constants";
import { baseHrCents, quoteForQueue, type Slot } from "../src/lib/pricing";
import { formatMoney } from "../src/lib/pricing/format";

/**
 * The market panel's sparse and flat states (#13).
 *
 * The panel is held behind `NEXT_PUBLIC_MARKET_PANEL_ENABLED` by decision D3, so
 * these skip rather than fail when it is off — a contributor without the flag
 * gets skips, and CI sets it so the coverage is real. The value is inlined at
 * build time, so flipping it needs a rebuild, not just a different test run.
 */
const PANEL_ENABLED = process.env.NEXT_PUBLIC_MARKET_PANEL_ENABLED === "true";

test.describe.configure({ mode: "serial" });
test.skip(
  !PANEL_ENABLED,
  "Market panel is behind NEXT_PUBLIC_MARKET_PANEL_ENABLED (decision D3). Set it and rebuild.",
);

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const HOUR = 3_600_000;

async function clear() {
  await db.askSample.deleteMany();
  await db.purchase.deleteMany();
}

/**
 * Truncated to the hour, which is the grain samples are stored at.
 *
 * Anchored once at module load rather than reading the clock per call. Reading
 * it per call means a seeding loop that happens to cross an hour boundary maps
 * two iterations onto the same truncated hour, and `(slot, hour)` is unique — so
 * the suite fails on the constraint, at whatever time of day it happens to run.
 */
const ANCHOR = Date.now();

function hourAt(hoursAgo: number): Date {
  return new Date(Math.floor((ANCHOR - hoursAgo * HOUR) / HOUR) * HOUR);
}

/**
 * `count` consecutive hourly samples ending an hour ago.
 *
 * `askFor` decides each hour's ask, so a caller can lay down a flat run or a
 * moving one without this helper knowing which.
 */
async function seedSamples(
  slot: Slot,
  count: number,
  askFor: (index: number) => number,
  queuedHours = 0,
) {
  for (let i = 0; i < count; i += 1) {
    await db.askSample.create({
      data: {
        slot,
        hour: hourAt(count - i),
        askHrCents: askFor(i),
        baseHrCents: baseHrCents(slot),
        queuedHours,
      },
    });
  }
}

async function seedSales(slot: Slot, count: number) {
  for (let i = 0; i < count; i += 1) {
    const q = quoteForQueue(slot, 1, 0);
    await db.purchase.create({
      data: {
        slot,
        durationH: 1,
        handle: `buyer_${slot}_${i}`,
        platform: "github",
        targetUrl: `https://github.com/buyer_${slot}_${i}`,
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: q.askHrCents,
        totalPaidCents: q.totalCents,
        status: "queued",
        boughtAt: new Date(Date.now() - (i + 1) * 60_000),
      },
    });
  }
}

async function gotoMarket(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "The market" })).toBeVisible();
}

function panel(page: Page) {
  return page.getByRole("region", { name: "The market" });
}

function slotTicker(page: Page, slot: Slot) {
  return panel(page).getByRole("button", { name: new RegExp(`^SLOT 0${slot},`) });
}

test.describe("the sparse state", () => {
  test.beforeAll(async () => {
    await clear();
    // Six sampled hours, well under the reveal threshold, and three real sales.
    await seedSamples(1, 6, () => baseHrCents(1));
    await seedSales(1, 3);
  });

  test("states the real sale count and the real hours since opening", async ({ page }) => {
    await gotoMarket(page);

    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toBeVisible();
    await expect(panel(page).getByText("Slot 01 has taken 3 sales since it opened")).toBeVisible();
  });

  test("points at the ledger rather than apologising", async ({ page }) => {
    await gotoMarket(page);
    await expect(
      panel(page).getByText(
        "Not enough hours of trading to draw a candle chart yet. Every sale so far is in the tape below.",
      ),
    ).toBeVisible();
  });

  /** Launch day: a slot nothing has been sampled on at all. */
  test("reads sensibly for a slot that has never traded", async ({ page }) => {
    await gotoMarket(page);
    await slotTicker(page, 2).click();

    await expect(
      panel(page).getByText("Slot 02 has not opened yet. Nothing has been sampled on it."),
    ).toBeVisible();
  });

  /** The panel has to keep its shape, or the sparse state reads as a broken page. */
  test("keeps the ticker strip and the range controls visible", async ({ page }) => {
    await gotoMarket(page);

    for (const slot of [1, 2, 3] as Slot[]) {
      await expect(slotTicker(page, slot)).toBeVisible();
    }
    for (const label of ["12H", "24H", "48H", "5D"]) {
      await expect(panel(page).getByRole("button", { name: label, exact: true })).toBeVisible();
    }
  });

  test("draws no chart region at all", async ({ page }) => {
    await gotoMarket(page);
    await expect(panel(page).getByText(/SAMPLED HOURS?$/)).toHaveCount(0);
  });
});

test.describe("the flat state", () => {
  test.beforeAll(async () => {
    await clear();
    // Past the reveal threshold, and the trailing window sits at base.
    await seedSamples(3, MARKET_REVEAL_HOURS + 2, () => baseHrCents(3));
    await seedSales(3, 2);
  });

  test("reads as availability, not as an error", async ({ page }) => {
    await gotoMarket(page);
    await slotTicker(page, 3).click();

    await expect(
      panel(page).getByText(
        `Slot 03 has sat at its base rate of ${formatMoney(baseHrCents(3))}/hr for the last six hours. ` +
          "No queue, no surge — it is available at base right now.",
      ),
    ).toBeVisible();
  });

  test("keeps the controls and shows a chart region alongside the note", async ({ page }) => {
    await gotoMarket(page);
    await slotTicker(page, 3).click();

    await expect(panel(page).getByRole("button", { name: "24H", exact: true })).toBeVisible();
    await expect(panel(page).getByText(/SAMPLED HOURS?$/)).toBeVisible();
    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toHaveCount(0);
  });
});

test.describe("switching slots and ranges", () => {
  test.beforeAll(async () => {
    await clear();
    // Slot 1 has enough hours and is moving; slot 2 is thin.
    await seedSamples(1, MARKET_REVEAL_HOURS + 4, (i) =>
      i % 2 === 0 ? baseHrCents(1) : Math.round(baseHrCents(1) * 1.6),
    );
    await seedSamples(2, 3, () => baseHrCents(2));
    await seedSales(1, 7);
  });

  /**
   * The panel must not remount between states — the ticker strip and the range
   * controls are the same elements before and after, so the page does not jump.
   */
  test("swaps content without tearing down the controls", async ({ page }) => {
    await gotoMarket(page);

    const range = panel(page).getByRole("button", { name: "24H", exact: true });
    await expect(range).toBeVisible();
    // Mark the live element; if the panel remounted, the marker would be gone.
    await range.evaluate((el) => el.setAttribute("data-kept", "yes"));

    await slotTicker(page, 2).click();
    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toBeVisible();

    await slotTicker(page, 1).click();
    await expect(panel(page).getByText(/SAMPLED HOURS?$/)).toBeVisible();

    await expect(range).toHaveAttribute("data-kept", "yes");
  });

  /**
   * The range narrows what is drawn, never what is true. A real market seen
   * through a 12-hour window is a short view, not a market that is still opening.
   */
  test("a narrow range does not drop a real market back to sparse", async ({ page }) => {
    await gotoMarket(page);
    await panel(page).getByRole("button", { name: "12H", exact: true }).click();

    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toHaveCount(0);
    await expect(panel(page).getByText(/SAMPLED HOURS?$/)).toBeVisible();
  });

  /** Narrowing filters the series the server sent. It never regenerates one. */
  test("a narrower range shows fewer sampled hours, never more", async ({ page }) => {
    await gotoMarket(page);

    const count = async () => {
      const text = await panel(page)
        .getByText(/SAMPLED HOURS?$/)
        .innerText();
      return Number(text.match(/(\d+) SAMPLED/)![1]);
    };

    await panel(page).getByRole("button", { name: "48H", exact: true }).click();
    const wide = await count();

    await panel(page).getByRole("button", { name: "12H", exact: true }).click();
    const narrow = await count();

    expect(narrow).toBeLessThanOrEqual(wide);
    expect(narrow).toBeLessThanOrEqual(12);
  });
});

test.describe("the honest-numbers rule", () => {
  /** Hours deliberately missing from the middle of the series. */
  const GAP_HOURS = 3;

  test.beforeAll(async () => {
    await clear();
    // History with a three-hour hole in the middle: the job did not run. Enough
    // hours on either side that the hole does not drop the slot under the reveal
    // threshold — otherwise this would test the sparse state instead.
    const total = MARKET_REVEAL_HOURS + 6;
    for (let i = 0; i < total; i += 1) {
      const hoursAgo = total - i;
      if (hoursAgo >= 9 && hoursAgo <= 11) continue;
      await db.askSample.create({
        data: {
          slot: 1,
          hour: hourAt(hoursAgo),
          askHrCents: i % 2 === 0 ? baseHrCents(1) : Math.round(baseHrCents(1) * 1.6),
          baseHrCents: baseHrCents(1),
          queuedHours: 0,
        },
      });
    }
  });

  /**
   * The count shown has to be the count of hours actually sampled. If anything
   * back-filled the hole it would read 24 rather than 21.
   */
  test("never invents an hour to close a gap", async ({ page }) => {
    await gotoMarket(page);
    await panel(page).getByRole("button", { name: "48H", exact: true }).click();

    const text = await panel(page)
      .getByText(/SAMPLED HOURS?$/)
      .innerText();
    expect(Number(text.match(/(\d+) SAMPLED/)![1])).toBe(MARKET_REVEAL_HOURS + 6 - GAP_HOURS);
  });
});

test.describe("at 360px", () => {
  test.beforeAll(async () => {
    await clear();
    await seedSamples(1, FLAT_WINDOW_CANDLES, () => baseHrCents(1));
    await seedSales(1, 1);
  });

  test("is legible and does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await gotoMarket(page);

    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toBeVisible();
    await expect(slotTicker(page, 1)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "5D", exact: true })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});
