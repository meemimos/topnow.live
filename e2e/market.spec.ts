import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import {
  FLAT_WINDOW_CANDLES,
  MARKET_REVEAL_HOURS,
  SPARKLINE_MAX_WIDTH,
} from "../src/lib/market/constants";
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

/** The chart element, whether it is drawn as a sparkline or in full. */
function chart(page: Page) {
  return panel(page).getByTestId("price-chart");
}

/**
 * How many sampled hours the chart says it is drawing.
 *
 * Read off its accessible description rather than a test-only attribute, so the
 * assertion exercises the same string a screen reader gets.
 */
async function sampledHoursShown(page: Page): Promise<number> {
  const label = await chart(page).getAttribute("aria-label");
  return Number(label!.match(/over (\d+) sampled hours/)![1]);
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

  test("draws no chart at all", async ({ page }) => {
    await gotoMarket(page);
    await expect(chart(page)).toHaveCount(0);
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
    await expect(chart(page)).toBeVisible();
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

    // Wait for the chart before marking anything. The chart is client-only, so
    // its presence proves hydration has finished — and a marker stamped on the
    // server-rendered DOM before that can be lost to hydration rather than to a
    // remount, which is the thing this test is trying to distinguish.
    await expect(chart(page)).toBeVisible();

    const range = panel(page).getByRole("button", { name: "24H", exact: true });
    await expect(range).toBeVisible();
    // Mark the live element; if the panel remounted, the marker would be gone.
    await range.evaluate((el) => el.setAttribute("data-kept", "yes"));

    await slotTicker(page, 2).click();
    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toBeVisible();

    await slotTicker(page, 1).click();
    await expect(chart(page)).toBeVisible();

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
    await expect(chart(page)).toBeVisible();
  });

  /** Narrowing filters the series the server sent. It never regenerates one. */
  test("a narrower range shows fewer sampled hours, never more", async ({ page }) => {
    await gotoMarket(page);

    await panel(page).getByRole("button", { name: "48H", exact: true }).click();
    const wide = await sampledHoursShown(page);

    await panel(page).getByRole("button", { name: "12H", exact: true }).click();
    const narrow = await sampledHoursShown(page);

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

    expect(await sampledHoursShown(page)).toBe(MARKET_REVEAL_HOURS + 6 - GAP_HOURS);
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

test.describe("the chart", () => {
  test.beforeAll(async () => {
    await clear();
    // Past the reveal threshold and moving, so the chart draws rather than
    // degrading to a note.
    await seedSamples(1, MARKET_REVEAL_HOURS + 4, (i) =>
      i % 2 === 0 ? baseHrCents(1) : Math.round(baseHrCents(1) * 1.6),
    );
    await seedSales(1, 4);
  });

  test("draws a candle chart with the base line and the attribution", async ({ page }) => {
    await gotoMarket(page);

    const chart = panel(page).getByTestId("price-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-spark", "false");
    // The library renders to canvas, so the chart existing means canvases exist.
    await expect(chart.locator("canvas").first()).toBeVisible();

    // TradingView attribution is a licence requirement, not decoration.
    const credit = panel(page).getByRole("link", { name: "Charts by TradingView" });
    await expect(credit).toBeVisible();
    await expect(credit).toHaveAttribute("href", "https://www.tradingview.com/");
    await expect(panel(page).getByText("CHART ENGINE")).toBeVisible();
  });

  /** The canvas carries no text, so the reading of the chart lives on the element. */
  test("describes itself for a screen reader", async ({ page }) => {
    await gotoMarket(page);

    await expect(
      panel(page).getByRole("img", { name: /Hourly candles of the ask over \d+ sampled hours/ }),
    ).toBeVisible();
  });

  test("keeps the ticker strip pinned as the panel scrolls", async ({ page }) => {
    await gotoMarket(page);

    // Asserted on the strip itself rather than by reaching for a button's
    // parentElement. The panel re-renders on the clock tick, so a node resolved
    // one moment can be detached the next — and getComputedStyle on a detached
    // node returns an empty declaration, which reads as "not sticky" rather than
    // as "look again". toHaveCSS re-resolves the locator on each attempt.
    await expect(panel(page).getByRole("group", { name: "Pick a slot" })).toHaveCSS(
      "position",
      "sticky",
    );
  });

  /**
   * A range with almost nothing in it degrades to a note rather than drawing a
   * two-pixel stub — and it must not claim the market is "still opening", which
   * would be false for a slot with a full history behind it.
   */
  test("a range with too little in it says so, without calling the market new", async ({
    page,
  }) => {
    await clear();
    // Enough history to be a real market, but all of it older than 12 hours.
    for (let i = 0; i < MARKET_REVEAL_HOURS + 4; i += 1) {
      await db.askSample.create({
        data: {
          slot: 1,
          hour: hourAt(MARKET_REVEAL_HOURS + 20 - i),
          askHrCents: i % 2 === 0 ? baseHrCents(1) : Math.round(baseHrCents(1) * 1.6),
          baseHrCents: baseHrCents(1),
          queuedHours: 0,
        },
      });
    }

    await gotoMarket(page);
    await panel(page).getByRole("button", { name: "12H", exact: true }).click();

    await expect(panel(page).getByText("NOTHING IN THIS RANGE")).toBeVisible();
    await expect(panel(page).getByText("MARKET IS STILL OPENING")).toHaveCount(0);
    await expect(panel(page).getByTestId("price-chart")).toHaveCount(0);

    // Widening brings the chart back.
    await panel(page).getByRole("button", { name: "5D", exact: true }).click();
    await expect(panel(page).getByTestId("price-chart")).toBeVisible();
  });
});

test.describe("the chart under 620px", () => {
  test.beforeAll(async () => {
    await clear();
    await seedSamples(1, MARKET_REVEAL_HOURS + 4, (i) =>
      i % 2 === 0 ? baseHrCents(1) : Math.round(baseHrCents(1) * 1.6),
    );
    await seedSales(1, 3);
  });

  test("collapses to a sparkline with a control to expand it", async ({ page }) => {
    await page.setViewportSize({ width: SPARKLINE_MAX_WIDTH - 60, height: 900 });
    await gotoMarket(page);

    const chart = panel(page).getByTestId("price-chart");
    await expect(chart).toHaveAttribute("data-spark", "true");
    await expect(panel(page).getByRole("button", { name: "SHOW FULL CHART" })).toBeVisible();
  });

  test("expands to the full interactive chart on demand", async ({ page }) => {
    await page.setViewportSize({ width: SPARKLINE_MAX_WIDTH - 60, height: 900 });
    await gotoMarket(page);

    await panel(page).getByRole("button", { name: "SHOW FULL CHART" }).click();

    const chart = panel(page).getByTestId("price-chart");
    await expect(chart).toHaveAttribute("data-spark", "false");
    await expect(chart.locator("canvas").first()).toBeVisible();
    // The control has done its job and stands down.
    await expect(panel(page).getByRole("button", { name: "SHOW FULL CHART" })).toHaveCount(0);
  });

  test("stays a full chart above the threshold", async ({ page }) => {
    await page.setViewportSize({ width: SPARKLINE_MAX_WIDTH + 200, height: 900 });
    await gotoMarket(page);

    await expect(panel(page).getByTestId("price-chart")).toHaveAttribute("data-spark", "false");
    await expect(panel(page).getByRole("button", { name: "SHOW FULL CHART" })).toHaveCount(0);
  });
});

test.describe("where the chart sits", () => {
  test.beforeAll(async () => {
    await clear();
    await seedSamples(1, 4, () => baseHrCents(1));
    await seedSales(1, 1);
  });

  /** The chart corroborates the board; it does not sell the slot (#12). */
  test("sits below both the board and the ledger", async ({ page }) => {
    await gotoMarket(page);

    const order = await page.evaluate(() => {
      const labels = ["The board", "The ledger", "The market"];
      return labels.map((label) => {
        const el = document.querySelector(`[aria-label="${label}"]`);
        return el ? el.getBoundingClientRect().top + window.scrollY : Number.NaN;
      });
    });

    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });
});
