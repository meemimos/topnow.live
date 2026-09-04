import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { ODOMETER_DIGITS } from "../src/lib/visits/constants";

/**
 * The hit counter and the online LCD (#15).
 *
 * The counter is a joke that only works if the number is real, so most of what
 * follows is about the number rather than about the animation: a real three
 * shows as `0000003`, zero renders honestly, and nothing anywhere rounds up.
 */
test.describe.configure({ mode: "serial" });

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/**
 * Seeds `count` visitors who are online right now, on top of whoever the page
 * load itself adds.
 */
async function seedOnline(count: number) {
  const now = new Date();
  await db.visit.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      visitorHash: String(i + 1).padStart(64, "0"),
      bucket: new Date(Math.floor(now.getTime() / 1_800_000) * 1_800_000),
      firstSeenAt: now,
      lastSeenAt: now,
    })),
  });
}

async function clear() {
  await db.visit.deleteMany();
  await db.askSample.deleteMany();
  await db.embed.deleteMany();
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
}

function counters(page: Page) {
  return page.getByRole("region", { name: "Site counters" });
}

function odometer(page: Page) {
  return counters(page).locator("[data-odometer]");
}

function lcd(page: Page) {
  return counters(page).locator("[data-lcd]");
}

/**
 * Reload until a counter shows the expected value.
 *
 * These specs truncate the visit table behind the running server's back, and the
 * counts are served from a short-lived process cache — so the first render after
 * a seed can legitimately still be the previous number. Reloading is what
 * produces a new server render; polling is what waits out the cache. A reload
 * does not disturb the count: the same visitor in the same window is a return,
 * not a new visit.
 */
async function expectCounter(page: Page, target: "odometer" | "lcd", value: string) {
  const read = target === "odometer" ? odometer : lcd;
  await expect
    .poll(
      async () => {
        await page.reload();
        return read(page).getAttribute("data-value");
      },
      { timeout: 25_000, message: `waiting for the ${target} to read ${value}` },
    )
    .toBe(value);
}

/** The digits as the reader sees them: the cell offsets, not the DOM text. */
async function shownDigits(page: Page): Promise<string> {
  return odometer(page).evaluate((el) =>
    Array.from(el.querySelectorAll(":scope > span"))
      .map((cell) => {
        const strip = cell.firstElementChild as HTMLElement;
        // Each digit is a window onto a 0-9 strip; the offset is the value.
        const percent = Number(/translateY\(([-\d.]+)%\)/.exec(strip.style.transform)?.[1] ?? "0");
        return String(Math.round(-percent / 10));
      })
      .join(""),
  );
}

test.describe("a real number, padded", () => {
  test.beforeEach(async () => {
    await clear();
  });

  test("shows a real three as 0000003", async ({ page }) => {
    // Two visits seeded, plus the one this page load makes: three.
    await db.visit.createMany({
      data: [
        { visitorHash: "a".repeat(64), bucket: new Date("2026-01-01T00:00:00Z") },
        { visitorHash: "b".repeat(64), bucket: new Date("2026-01-01T00:30:00Z") },
      ],
    });

    await page.goto("/");
    await expect(odometer(page)).toBeVisible();

    // Padding is presentation. An inflated three would be a lie told in the
    // same space, which is the whole point of this test.
    await expectCounter(page, "odometer", "3");
    expect(await shownDigits(page)).toBe("0000003");
  });

  test("has exactly seven cells, whatever the number", async ({ page }) => {
    await page.goto("/");
    await expect(odometer(page).locator(":scope > span")).toHaveCount(ODOMETER_DIGITS);
  });

  test("counts a reload as the same visit", async ({ page }) => {
    await page.goto("/");
    await page.reload();
    await page.reload();

    // Three renders, one row. Ten reloads is one person looking, and the
    // counter says so.
    expect(await db.visit.count()).toBe(1);
    await expectCounter(page, "odometer", "1");
  });
});

test.describe("online now", () => {
  test.beforeEach(async () => {
    await clear();
  });

  test("floors at the truth and pads to three", async ({ page }) => {
    await page.goto("/");
    await expectCounter(page, "lcd", "1");
    // A real one shows as 001. Padding is presentation; the value is not.
    await expect(lcd(page)).toHaveText("001");
  });

  test("says something true rather than the prototype's per-slot claim", async ({ page }) => {
    await page.goto("/");
    // Nothing measures which part of the page anybody is looking at, so the
    // line says what the number beside it actually counts.
    await expect(counters(page).getByText("on the board right now")).toBeVisible();
    await expect(counters(page).getByText(/looking at slot 01/)).toHaveCount(0);
  });

  test("states the window it means by 'now'", async ({ page }) => {
    await page.goto("/");
    await expect(counters(page).getByText(/seen in the last 5 minutes/)).toBeVisible();
  });
});

test.describe("presentation", () => {
  test.beforeAll(clear);

  test("exposes one sentence to assistive tech, not ten digits per cell", async ({ page }) => {
    await page.goto("/");

    await expect(counters(page).getByRole("img", { name: /visits since launch/ })).toBeVisible();
    await expect(counters(page).getByRole("img", { name: /on the board right now/ })).toBeVisible();

    // Every cell is hidden from the tree; the label carries the value.
    const exposed = await odometer(page)
      .locator(":scope > span")
      .evaluateAll((nodes) => nodes.filter((n) => n.getAttribute("aria-hidden") !== "true").length);
    expect(exposed).toBe(0);
  });

  test("rolls the digits with the prototype's own timing", async ({ page }) => {
    await page.goto("/");
    const timing = await odometer(page).evaluate((el) => {
      const strip = el.querySelector(":scope > span > span")!;
      const style = getComputedStyle(strip);
      return { duration: style.transitionDuration, timing: style.transitionTimingFunction };
    });

    expect(timing.duration).toBe("0.4s");
    expect(timing.timing).toBe("cubic-bezier(0.2, 0.7, 0.2, 1)");
  });

  test("does not roll under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const duration = await odometer(page).evaluate(
      (el) => getComputedStyle(el.querySelector(":scope > span > span")!).transitionDuration,
    );
    // The digit changes instantly instead. The value is never hidden — only the
    // movement is.
    expect(Number.parseFloat(duration)).toBeLessThan(0.05);
    await expect(odometer(page)).toBeVisible();
  });

  test("every cell is the same fixed width", async ({ page }) => {
    await page.goto("/");
    const widths = await odometer(page)
      .locator(":scope > span")
      .evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().width)));

    // Fixed-width cells are what stop the panel resizing as the number rolls,
    // so a 1 must occupy exactly what an 8 does.
    expect(new Set(widths).size).toBe(1);
  });

  test("does not shift when the LCD crosses a digit boundary", async ({ page }) => {
    await clear();
    await seedOnline(9);
    await page.goto("/");

    await expectCounter(page, "lcd", "10");
    const at10 = await lcd(page).boundingBox();

    await clear();
    await seedOnline(8);
    await expectCounter(page, "lcd", "9");
    const at9 = await lcd(page).boundingBox();

    // 9 → 10 must not move anything: fixed min-width plus tabular-nums.
    expect(at10?.width).toBeCloseTo(at9?.width ?? 0, 0);
  });
});

test.describe("bots are not counted", () => {
  test.beforeEach(async () => {
    await clear();
  });

  test("a crawler does not move the number", async ({ browser }) => {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    });
    const page = await context.newPage();
    await page.goto("/");
    await expect(counters(page)).toBeVisible();

    expect(await db.visit.count()).toBe(0);
    // Nothing invented to cover for the exclusion, either.
    await expectCounter(page, "odometer", "0");
    await context.close();
  });
});

test.describe("at 360px", () => {
  test.beforeAll(clear);

  test("both panels fit without pushing the page sideways", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/");
    await expect(counters(page)).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});
