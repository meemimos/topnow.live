import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";

/**
 * Queue position (#10) and the receipt (#9).
 *
 * Seeds real queue state, so it shares the serial `board` project — see
 * playwright.config.ts.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function seed(slot: Slot, durationH: DurationHours, handle: string, live = false) {
  const q = quoteForQueue(slot, durationH, 0);
  const boughtAt = new Date(Date.now() - 120_000);
  const startsAt = new Date(Date.now() - 60_000);
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
      boughtAt,
      ...(live
        ? {
            status: "live" as const,
            startsAt,
            endsAt: new Date(startsAt.getTime() + durationH * 3_600_000),
          }
        : { status: "queued" as const }),
    },
  });
}

async function quoteFor(page: Page, handle = "mira-builds") {
  await page.goto("/checkout", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.fill('input[aria-describedby="derived-url"]', handle);
  await page.getByText("One line of copy").locator("..").locator("input").fill("A tagline.");
  await page.getByRole("button", { name: "CONTINUE" }).click();
  await expect(page.getByText("TOPNOW RECEIPT")).toBeVisible();
}

test.afterAll(async () => {
  await db.purchase.deleteMany();
  await db.$disconnect();
});

test.describe("a free slot", () => {
  test.beforeAll(async () => {
    await db.purchase.deleteMany();
  });

  /**
   * The free case is its own sentence, not the queued sentence with a clause
   * removed, so going live immediately reads as cleanly as it is.
   */
  test("says only when it ends, with no queue language", async ({ page }) => {
    await quoteFor(page);

    await expect(page.getByText(/Yours until/)).toBeVisible();
    await expect(page.getByText(/in line/)).toHaveCount(0);
    await expect(page.getByText("IMMEDIATELY")).toBeVisible();
  });

  test("the button says take, not join", async ({ page }) => {
    await quoteFor(page);
    await expect(page.getByRole("button", { name: /^TAKE SLOT 01 — \$/ })).toBeVisible();
  });

  test("shows no surge note at base", async ({ page }) => {
    await quoteFor(page);
    await expect(page.getByText(/^SURGE /)).toHaveCount(0);
  });
});

test.describe("a queued slot", () => {
  test.beforeAll(async () => {
    await db.purchase.deleteMany();
    await seed(1, 6, "holder", true);
    await seed(1, 6, "first-waiting");
    await seed(1, 6, "second-waiting");
  });

  /**
   * The rule from #10: never show "yours until 7:39 PM" to somebody who is
   * fourth in line. Position comes first, then the estimate, then the end.
   */
  test("states position before it states any end time", async ({ page }) => {
    await quoteFor(page, "late-arrival");

    const text =
      (await page
        .getByText(/in line/)
        .first()
        .textContent()) ?? "";
    const positionAt = text.indexOf("in line");
    const untilAt = text.indexOf("yours until");

    expect(positionAt).toBeGreaterThanOrEqual(0);
    expect(untilAt).toBeGreaterThan(positionAt);
  });

  test("uses the correct ordinal", async ({ page }) => {
    await quoteFor(page, "late-arrival");
    // Two already queued, so a new buyer is third.
    await expect(page.getByText(/3rd in line/)).toBeVisible();
    // exact, because getByText is case-insensitive and would also match the
    // prose "3rd in line" above.
    await expect(page.getByText("3RD IN LINE", { exact: true })).toBeVisible();
  });

  test("marks the start as an estimate", async ({ page }) => {
    await quoteFor(page, "late-arrival");
    await expect(page.getByText(/Estimated start/)).toBeVisible();
    await expect(page.getByText(/Estimated, because a listing taken down early/)).toBeVisible();
  });

  test("the button says join queue", async ({ page }) => {
    await quoteFor(page, "late-arrival");
    await expect(page.getByRole("button", { name: /^JOIN QUEUE FOR SLOT 01 — \$/ })).toBeVisible();
  });

  test("explains surge as a multiplier", async ({ page }) => {
    await quoteFor(page, "late-arrival");
    await expect(page.getByText(/^SURGE 1\.50×/)).toBeVisible();
  });

  /**
   * The reason #2 quantises multipliers before pricing anything: a buyer can
   * multiply the three printed numbers and land exactly on the printed total.
   */
  test("the printed derivation multiplies out to the printed total", async ({ page }) => {
    await quoteFor(page, "late-arrival");

    const derivation = (await page
      .getByText(/BASE ×/)
      .first()
      .textContent())!;
    const [, base, multiplier, hours] = derivation.match(
      /\$([\d.]+) BASE × ([\d.]+) SURGE × (\d+)H/,
    )!;

    const totalText = (await page.getByText("TOTAL").locator("..").textContent())!;
    const printedTotal = Number(totalText.match(/\$([\d.]+)/)![1]);

    expect(Number(base) * Number(multiplier) * Number(hours)).toBeCloseTo(printedTotal, 2);
  });

  test("the line item shows the effective rate, not the base rate", async ({ page }) => {
    await quoteFor(page, "late-arrival");
    // 12 queued hours is 1.50x, so $5.00 base is charged at $7.50.
    await expect(page.getByText("3H AT $7.50/HR")).toBeVisible();
  });

  // A premium is a multiplier, never a colour.
  test("nothing in the receipt is red or green", async ({ page }) => {
    await quoteFor(page, "late-arrival");

    const offending = await page.evaluate(() => {
      const receipt = Array.from(document.querySelectorAll("div")).find((d) =>
        d.textContent?.startsWith("TOPNOW RECEIPT"),
      )!;
      const banned = ["rgb(196, 0, 0)", "rgb(0, 160, 0)"];
      return Array.from(receipt.querySelectorAll("*")).filter((n) => {
        const s = getComputedStyle(n);
        return banned.includes(s.color) || banned.includes(s.backgroundColor);
      }).length;
    });

    expect(offending).toBe(0);
  });
});

test.describe("a slot past the wait cap", () => {
  test.beforeAll(async () => {
    await db.purchase.deleteMany();
    await seed(1, 24, "holder", true);
    await seed(1, 24, "long-waiter");
  });

  /**
   * A full slot is a state the buyer gets explained, not an unexplained
   * disabled button (#10).
   */
  test("says it is full, when it reopens, and what else is open", async ({ page }) => {
    await page.goto("/checkout", { waitUntil: "networkidle" });
    await page.fill('input[aria-describedby="derived-url"]', "hopeful");
    await page.getByText("One line of copy").locator("..").locator("input").fill("A tagline.");
    await page.getByRole("button", { name: "CONTINUE" }).click();

    const alert = page.locator('[role="alert"]').first();
    await expect(alert).toContainText(/Slot 01 is full/);
    await expect(alert).toContainText(/another \d+h/);
    await expect(alert).toContainText(/slot 02|slot 03/);
  });
});
