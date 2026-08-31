import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Platform } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { quoteForQueue, type DurationHours, type Slot } from "../src/lib/pricing";
import { formatMoney, formatMultiplierAgainstBase } from "../src/lib/pricing/format";

/**
 * The ledger (#11).
 *
 * Driven from real database state rather than a fixture, because the claim worth
 * testing is that one query over one table produces three sections that agree
 * with each other.
 *
 * Seeding touches a database every worker shares, so this file gets a Playwright
 * project of its own and runs after the other stateful suites.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const HOUR = 3_600_000;

async function clear() {
  await db.purchase.deleteMany();
}

function base(slot: Slot, durationH: DurationHours, handle: string, platform: Platform = "github") {
  const q = quoteForQueue(slot, durationH, 0);
  return {
    slot,
    durationH,
    handle,
    platform,
    targetUrl: `https://github.com/${handle}`,
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
    priceHrCents: q.askHrCents,
    totalPaidCents: q.totalCents,
  };
}

async function seedLive(slot: Slot, durationH: DurationHours, handle: string) {
  const startsAt = new Date(Date.now() - 30_000);
  return db.purchase.create({
    data: {
      ...base(slot, durationH, handle),
      status: "live",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationH * HOUR),
    },
  });
}

async function seedQueued(
  slot: Slot,
  durationH: DurationHours,
  handle: string,
  minutesAgo: number,
) {
  return db.purchase.create({
    data: {
      ...base(slot, durationH, handle),
      status: "queued",
      boughtAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

async function seedEnded(slot: Slot, durationH: DurationHours, handle: string, hoursAgo: number) {
  const endsAt = new Date(Date.now() - hoursAgo * HOUR);
  const startsAt = new Date(endsAt.getTime() - durationH * HOUR);
  return db.purchase.create({
    data: {
      ...base(slot, durationH, handle),
      status: "ended",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt,
    },
  });
}

async function gotoLedger(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "The ledger" })).toBeVisible();
}

/** The ledger's own table, so assertions cannot drift onto some other table. */
function table(page: Page) {
  return page.getByRole("region", { name: "The ledger" }).locator("table");
}

/**
 * A slot filter button, scoped to the ledger.
 *
 * The board's own CTAs read "TAKE SLOT 03 — $2.00/HR", so an unscoped, inexact
 * lookup for "SLOT 03" finds the board's button as readily as the filter.
 */
function filterButton(page: Page, name: string) {
  return page
    .getByRole("region", { name: "The ledger" })
    .getByRole("button", { name, exact: true });
}

/**
 * The three section headers.
 *
 * Targeted by `scope="colgroup"` rather than by text: "ENDED" is also the status
 * badge on every ended row, so matching on the word alone would find the badges
 * too — and the thing being asserted is that these are real section headers.
 */
function sectionHeaders(page: Page) {
  return table(page).locator('th[scope="colgroup"]');
}

/** Row names in document order, which is what the section ordering claims are about. */
async function namesInOrder(page: Page): Promise<string[]> {
  return table(page)
    .locator("tbody tr td:first-child > span:first-child")
    .allInnerTexts()
    .then((texts) => texts.map((t) => t.trim()));
}

test.describe("three sections, one dataset", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(1, 6, "on_board_now");
    await seedQueued(1, 3, "waiting_first", 90);
    await seedQueued(1, 1, "waiting_second", 40);
    await seedEnded(2, 1, "ended_recent", 2);
    await seedEnded(2, 3, "ended_older", 9);
  });

  test("renders one table with all three section headers", async ({ page }) => {
    await gotoLedger(page);

    await expect(table(page)).toHaveCount(1);
    // One table, three sections — not three tables stacked up.
    await expect(sectionHeaders(page)).toHaveCount(3);
    await expect(sectionHeaders(page).nth(0)).toContainText("ON THE BOARD NOW");
    await expect(sectionHeaders(page).nth(1)).toContainText("IN THE QUEUE");
    await expect(sectionHeaders(page).nth(2)).toContainText("ENDED");
  });

  /**
   * The queue reads oldest-first and the tape newest-first. An unexplained
   * reversal inside one table looks like a sorting bug, so each header says which
   * way its own section runs.
   */
  test("each section header explains its own order", async ({ page }) => {
    await gotoLedger(page);

    await expect(
      table(page).getByText("oldest purchase first — earliest bought goes live soonest"),
    ).toBeVisible();
    await expect(table(page).getByText("most recent first — the tape")).toBeVisible();
  });

  test("orders the queue ascending and the tape descending", async ({ page }) => {
    await gotoLedger(page);
    const names = await namesInOrder(page);

    // Live, then the queue oldest-first, then the tape newest-first.
    expect(names).toEqual([
      "@on_board_now",
      "@waiting_first",
      "@waiting_second",
      "@ended_recent",
      "@ended_older",
    ]);
  });

  test("counts every purchase in the header", async ({ page }) => {
    await gotoLedger(page);
    await expect(page.getByText("5 PURCHASES")).toBeVisible();
  });

  test("uses a semantic table with real column headers", async ({ page }) => {
    await gotoLedger(page);

    for (const name of ["HANDLE", "DUR", "$/HR", "PAID", "STATUS"]) {
      await expect(table(page).getByRole("columnheader", { name, exact: true })).toBeVisible();
    }
    // The three sections are real <tbody> groups, so the structure survives into
    // the accessibility tree rather than being three visually-separated lists.
    await expect(table(page).locator("tbody")).toHaveCount(3);
  });

  test("a live row counts down against the shared clock", async ({ page }) => {
    await gotoLedger(page);

    const clock = table(page)
      .locator("tbody")
      .first()
      .locator("tr td:last-child > span:last-child");
    const first = await clock.innerText();
    await expect(clock).not.toHaveText(first, { timeout: 3000 });
  });

  test("a queued row marks its start as an estimate", async ({ page }) => {
    await gotoLedger(page);
    // The tilde is the whole point: a queued start is an estimate, not a promise.
    await expect(
      table(page)
        .getByText(/^~\d{1,2}:\d{2}\s?(AM|PM)$/)
        .first(),
    ).toBeVisible();
  });
});

test.describe("the price columns", () => {
  test.beforeAll(async () => {
    await clear();
    // 12 queued hours against a 24h cap is 1.50x, so slot 01 asks $7.50/hr.
    const q = quoteForQueue(1, 3, 12);
    await db.purchase.create({
      data: {
        ...base(1, 3, "surged_buyer"),
        priceHrCents: q.askHrCents,
        totalPaidCents: q.totalCents,
        status: "queued",
        boughtAt: new Date(Date.now() - 60_000),
      },
    });
  });

  test("prints the rate actually paid, with its multiplier beneath", async ({ page }) => {
    await gotoLedger(page);
    const quote = quoteForQueue(1, 3, 12);

    await expect(
      table(page).getByText(formatMoney(quote.askHrCents), { exact: true }),
    ).toBeVisible();
    await expect(
      table(page).getByText(formatMultiplierAgainstBase(quote.multiplierCm)),
    ).toBeVisible();
    await expect(
      table(page).getByText(formatMoney(quote.totalCents), { exact: true }),
    ).toBeVisible();
  });

  /** Green and red belong to the chart and mean price direction. Not here. */
  test("nothing in the ledger is red or green", async ({ page }) => {
    await gotoLedger(page);

    const offending = await page.evaluate(() => {
      const region = document.querySelector('[aria-label="The ledger"]')!;
      const banned = ["rgb(196, 0, 0)", "rgb(0, 160, 0)"];
      return Array.from(region.querySelectorAll("*")).filter((n) => {
        const s = getComputedStyle(n);
        return banned.includes(s.color) || banned.includes(s.backgroundColor);
      }).length;
    });

    expect(offending).toBe(0);
  });
});

test.describe("the slot filter", () => {
  test.beforeAll(async () => {
    await clear();
    await seedLive(1, 6, "live_on_one");
    await seedLive(2, 6, "live_on_two");
    await seedQueued(1, 1, "queued_on_one", 30);
    await seedQueued(2, 1, "queued_on_two", 30);
    await seedEnded(1, 1, "ended_on_one", 4);
    await seedEnded(2, 1, "ended_on_two", 4);
  });

  test("narrows all three sections at once", async ({ page }) => {
    await gotoLedger(page);
    await expect(page.getByText("6 PURCHASES")).toBeVisible();

    await filterButton(page, "SLOT 01").click();

    expect(await namesInOrder(page)).toEqual(["@live_on_one", "@queued_on_one", "@ended_on_one"]);
    await expect(page.getByText("3 PURCHASES")).toBeVisible();
    // Every section narrowed, not just the one being looked at.
    await expect(table(page).getByText("@live_on_two")).toHaveCount(0);
    await expect(table(page).getByText("@queued_on_two")).toHaveCount(0);
    await expect(table(page).getByText("@ended_on_two")).toHaveCount(0);
  });

  test("restores every row on ALL", async ({ page }) => {
    await gotoLedger(page);
    await filterButton(page, "SLOT 03").click();
    await expect(page.getByText("0 PURCHASES")).toBeVisible();

    await filterButton(page, "ALL").click();
    await expect(page.getByText("6 PURCHASES")).toBeVisible();
  });

  test("shows the filter state on the control itself", async ({ page }) => {
    await gotoLedger(page);
    const all = filterButton(page, "ALL");
    const one = filterButton(page, "SLOT 01");

    await expect(all).toHaveAttribute("aria-pressed", "true");
    await one.click();
    await expect(one).toHaveAttribute("aria-pressed", "true");
    await expect(all).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("at 360px", () => {
  /**
   * A long handle with no break opportunity in it at all, which is the case that
   * actually breaks the layout: the HANDLE column's min-content width otherwise
   * drags the whole table past the viewport.
   *
   * Letters only, deliberately. Hyphens and punctuation are break opportunities,
   * so a hyphenated handle wraps on its own and would pass whether or not the
   * fix is present.
   */
  const LONG_HANDLE = "averylonghandlewithnobreakopportunityanywhereinit";

  test.beforeAll(async () => {
    await clear();
    await seedLive(1, 6, LONG_HANDLE);
    await seedQueued(1, 3, "narrow_queued", 20);
  });

  /**
   * The columns drop rather than the table scrolling sideways. Slot stays
   * recoverable from the filter above; a sideways-scrolling table is not
   * recoverable from anything.
   */
  test("drops SLOT and BOUGHT, and does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await gotoLedger(page);

    await expect(table(page).getByRole("columnheader", { name: "SLOT", exact: true })).toBeHidden();
    await expect(
      table(page).getByRole("columnheader", { name: "BOUGHT", exact: true }),
    ).toBeHidden();
    await expect(
      table(page).getByRole("columnheader", { name: "HANDLE", exact: true }),
    ).toBeVisible();
    await expect(
      table(page).getByRole("columnheader", { name: "PAID", exact: true }),
    ).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });

  test("keeps both columns at 1280px", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoLedger(page);

    await expect(
      table(page).getByRole("columnheader", { name: "SLOT", exact: true }),
    ).toBeVisible();
    await expect(
      table(page).getByRole("columnheader", { name: "BOUGHT", exact: true }),
    ).toBeVisible();
  });
});

test.describe("sparse states", () => {
  test("renders an empty ledger honestly, with no invented rows", async ({ page }) => {
    await clear();
    await gotoLedger(page);

    await expect(page.getByText("0 PURCHASES")).toBeVisible();
    await expect(
      table(page).getByText("Nobody on the board. All three slots are open at base price."),
    ).toBeVisible();
    await expect(
      table(page).getByText("Nobody waiting. Buy it and you go live the second payment clears."),
    ).toBeVisible();
    // Three section headers, three empty lines, and nothing else.
    await expect(table(page).locator("tbody tr")).toHaveCount(6);
  });

  test("renders a ledger holding exactly one purchase", async ({ page }) => {
    await clear();
    await seedQueued(2, 1, "the_only_one", 5);
    await gotoLedger(page);

    await expect(page.getByText("1 PURCHASE", { exact: true })).toBeVisible();
    expect(await namesInOrder(page)).toEqual(["@the_only_one"]);
  });

  test("names the slot in the empty copy when filtered", async ({ page }) => {
    await clear();
    await gotoLedger(page);
    await filterButton(page, "SLOT 02").click();

    await expect(
      table(page).getByText("Nobody on slot 02 right now. It is open at base price."),
    ).toBeVisible();
  });
});

test.describe("untrusted listing text", () => {
  test.beforeAll(async () => {
    await clear();
    await db.purchase.create({
      data: {
        ...base(1, 1, '<img src=x onerror=alert(1)>&"q"'),
        status: "queued",
        boughtAt: new Date(Date.now() - 60_000),
      },
    });
  });

  // Handles are user-supplied. They render as text, never as markup.
  test("renders a handle as text, not markup", async ({ page }) => {
    await gotoLedger(page);

    await expect(table(page).getByText('@<img src=x onerror=alert(1)>&"q"')).toBeVisible();
    expect(await page.locator("img[src='x']").count()).toBe(0);
  });
});
