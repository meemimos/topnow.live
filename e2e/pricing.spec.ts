import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import {
  MAX_MULTIPLIER_CM,
  QUEUE_CAP_HOURS,
  baseHrCents,
  quoteForQueue,
  type DurationHours,
  type Slot,
} from "../src/lib/pricing";
import { formatMoney, formatMultiplier } from "../src/lib/pricing/format";

/**
 * The pricing dialog (#14).
 *
 * The figures in it must be live, so these seed a real queue and check the
 * dialog quotes the surge that queue actually produces — a static price list
 * beside a surging board is the failure mode worth testing for.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const CHART_LEGEND_SHOWN = process.env.NEXT_PUBLIC_MARKET_PANEL_ENABLED === "true";

async function clear() {
  await db.askSample.deleteMany();
  await db.purchase.deleteMany();
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
      tagline: "Open-source invoicing for freelancers who hate invoicing.",
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
      status: "queued",
      boughtAt: new Date(Date.now() - 60_000),
    },
  });
}

/**
 * A rental already on the board.
 *
 * Needed before anything can be *queued*: a lone queued purchase on a free slot
 * is promoted to live on the next board read, leaving no queue and no surge.
 */
async function seedLive(slot: Slot, durationH: DurationHours, handle: string) {
  const q = quoteForQueue(slot, durationH, 0);
  const startsAt = new Date(Date.now() - 60_000);
  return db.purchase.create({
    data: {
      slot,
      durationH,
      handle,
      platform: "github",
      targetUrl: `https://github.com/${handle}`,
      tagline: "Open-source invoicing for freelancers who hate invoicing.",
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
      status: "live",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * 3_600_000),
    },
  });
}

async function openDialog(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "SEE PRICING" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

test.describe("modal semantics", () => {
  test.beforeAll(clear);

  test("is a labelled dialog", async ({ page }) => {
    await openDialog(page);
    await expect(page.getByRole("dialog", { name: "PRICING" })).toBeVisible();
  });

  test("closes on Escape and restores focus to the trigger", async ({ page }) => {
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "SEE PRICING" });
    await trigger.click();
    await expect(dialog(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    // Focus must come back to what opened it, or a keyboard user is dumped at
    // the top of the document.
    await expect(trigger).toBeFocused();
  });

  test("closes on the X button", async ({ page }) => {
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);
  });

  /** A focus trap is the part of a modal easiest to get subtly wrong. */
  test("keeps focus inside while open", async ({ page }) => {
    await openDialog(page);

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"]');
        return Boolean(modal && document.activeElement && modal.contains(document.activeElement));
      });
      expect(inside).toBe(true);
    }
  });
});

test.describe("the figures are live", () => {
  test.beforeAll(async () => {
    await clear();
    // An occupant, then twelve hours queued behind it. Twelve queued hours
    // against a 24h cap is exactly 1.50x.
    await seedLive(1, 6, "on_board");
    await seedQueued(1, 12, "deep_queue");
  });

  test("quotes the surge the queue actually produces", async ({ page }) => {
    await openDialog(page);
    const surged = quoteForQueue(1, 1, 12);

    const row = dialog(page).getByRole("row").filter({ hasText: "01 — big card" });
    await expect(row).toContainText(`${formatMultiplier(surged.multiplierCm)}×`);
    await expect(row).toContainText(formatMoney(surged.askHrCents));
  });

  test("shows an unqueued slot at base and 1.00x", async ({ page }) => {
    await openDialog(page);
    const row = dialog(page).getByRole("row").filter({ hasText: "03 — compact row" });

    await expect(row).toContainText(formatMoney(baseHrCents(3)));
    await expect(row).toContainText("1.00×");
  });

  test("states each slot's base rate from the engine", async ({ page }) => {
    await openDialog(page);

    // Per row rather than by counting occurrences: an unqueued slot prints the
    // same figure in BASE and in ASK NOW, so a global count says more about how
    // many slots happen to be quiet than about the rates.
    const descriptions = ["01 — big card", "02 — compact row", "03 — compact row"];

    for (const [index, description] of descriptions.entries()) {
      const slot = (index + 1) as Slot;
      const row = dialog(page).getByRole("row").filter({ hasText: description });
      await expect(row).toContainText(formatMoney(baseHrCents(slot)));
    }
  });

  test("the slot descriptions justify the tiers", async ({ page }) => {
    await openDialog(page);

    await expect(dialog(page).getByText("01 — big card, embedded post")).toBeVisible();
    await expect(dialog(page).getByText("02 — compact row")).toBeVisible();
    await expect(dialog(page).getByText("03 — compact row")).toBeVisible();
  });
});

test.describe("the copy matches the implemented model", () => {
  test.beforeAll(clear);

  /**
   * The prototype's wording describes head count. The engine is driven by queued
   * hours (D2), and copy that says otherwise teaches the wrong mental model.
   */
  test("explains surge in queued hours, naming the real cap", async ({ page }) => {
    await openDialog(page);

    await expect(dialog(page).getByText(/hours queued on a slot/)).toBeVisible();
    await expect(dialog(page).getByText(/not by how many people are waiting/)).toBeVisible();
    await expect(
      dialog(page).getByText(new RegExp(`${QUEUE_CAP_HOURS} queued hours`)),
    ).toBeVisible();
    await expect(
      dialog(page).getByText(new RegExp(`${formatMultiplier(MAX_MULTIPLIER_CM)}× ceiling`)),
    ).toBeVisible();
  });

  test("states the flat-rate rule", async ({ page }) => {
    await openDialog(page);
    await expect(
      dialog(page).getByText(/Six hours costs exactly six times one hour/),
    ).toBeVisible();
  });

  test("opens with the model in one sentence", async ({ page }) => {
    await openDialog(page);
    await expect(dialog(page).getByText(/You pay a rate per hour/)).toBeVisible();
  });
});

test.describe("the chart legend", () => {
  test.beforeAll(clear);

  test("appears only when the chart does", async ({ page }) => {
    await openDialog(page);

    const legend = dialog(page).getByText("HOW TO READ THE CHART");
    if (CHART_LEGEND_SHOWN) {
      await expect(legend).toBeVisible();
    } else {
      // Decision D3 holds the chart behind a flag; explaining a chart the reader
      // cannot see would be worse than saying nothing.
      await expect(legend).toHaveCount(0);
    }
  });

  test("distinguishes up from down by fill, not only by hue", async ({ page }) => {
    test.skip(!CHART_LEGEND_SHOWN, "Chart legend hides with the chart (decision D3).");
    await openDialog(page);

    const swatches = dialog(page).locator("[data-swatch]");
    await expect(swatches).toHaveCount(3);
    await expect(swatches.nth(0)).toHaveAttribute("data-swatch", "filled");
    // The hollow one is what makes the legend readable in greyscale.
    await expect(swatches.nth(1)).toHaveAttribute("data-swatch", "hollow");
  });

  test("draws the swatches in the chart's own colours", async ({ page }) => {
    test.skip(!CHART_LEGEND_SHOWN, "Chart legend hides with the chart (decision D3).");
    await openDialog(page);

    const colours = await dialog(page)
      .locator("[data-swatch]")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const s = getComputedStyle(n);
          return { bg: s.backgroundColor, border: s.borderTopColor };
        }),
      );

    // Read from the same tokens the chart reads, so a retheme cannot leave the
    // legend describing colours the chart no longer uses.
    expect(colours[0]!.bg).toBe("rgb(0, 160, 0)");
    expect(colours[1]!.border).toBe("rgb(196, 0, 0)");
    expect(colours[2]!.bg).toBe("rgb(0, 0, 128)");
  });
});

test.describe("green and red appear nowhere else", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(1, 6, "on_board");
    await seedQueued(1, 12, "deep_queue");
  });

  /**
   * #14 makes the legend the only place these two colours appear outside the
   * chart canvas. Everywhere else a premium is a multiplier.
   */
  test("the page outside the chart carries no up or down colour", async ({ page }) => {
    await page.goto("/");

    const offending = await page.evaluate(() => {
      const banned = ["rgb(0, 160, 0)", "rgb(196, 0, 0)"];
      return Array.from(document.querySelectorAll("main *")).filter((n) => {
        const s = getComputedStyle(n);
        return banned.includes(s.color) || banned.includes(s.backgroundColor);
      }).length;
    });

    expect(offending).toBe(0);
  });
});

test.describe("at 360px", () => {
  test.beforeAll(clear);

  test("is legible and scrolls rather than clipping", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 620 });
    await openDialog(page);

    await expect(dialog(page).getByText(/You pay a rate per hour/)).toBeVisible();
    await expect(dialog(page).getByRole("link", { name: "PAY FOR TIME" })).toBeAttached();

    // The dialog is taller than the viewport, so the overlay must scroll it.
    const scrolls = await page.evaluate(() => {
      const overlay = document.querySelector('[role="dialog"]')!.parentElement!;
      return overlay.scrollHeight > overlay.clientHeight;
    });
    expect(scrolls).toBe(true);

    const overflowsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflowsSideways).toBe(false);
  });
});
