import { expect, test, type Page } from "@playwright/test";

/**
 * The countdown treatment (#7).
 *
 * The meter is the product's engine, so these assert what actually reaches the
 * browser — computed styles and live values — rather than class names.
 */

const METER = '[role="timer"]';
const AMBER = "rgb(255, 176, 0)";
const AMBER_BRIGHT = "rgb(255, 209, 102)";

async function gotoMeter(page: Page) {
  await page.goto("/dev/primitives");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(METER).first()).toBeVisible();
}

test("counts down once a second", async ({ page }) => {
  await gotoMeter(page);
  const meter = page.locator(METER).first();

  const before = await meter.getAttribute("aria-label");
  await page.waitForTimeout(2200);
  const after = await meter.getAttribute("aria-label");

  expect(before).not.toBe(after);
});

test("never runs backwards", async ({ page }) => {
  await gotoMeter(page);
  const readings: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const label = await page.locator(METER).first().getAttribute("aria-label");
    const match = label?.match(/(\d+) hours (\d+) minutes (\d+) seconds/);
    if (match) {
      readings.push(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    }
    await page.waitForTimeout(1100);
  }

  expect(readings.length).toBeGreaterThan(2);
  for (let i = 1; i < readings.length; i += 1) {
    expect(readings[i]).toBeLessThanOrEqual(readings[i - 1]);
  }
});

test.describe("with reduced motion", () => {
  // Emulated per-context rather than via test.use, which types reducedMotion as
  // a launch option this Playwright version does not expose on the fixture.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  /**
   * The one thing reduced motion does not switch off. The depletion bar stops
   * animating; the digits do not stop.
   */
  test("the clock still ticks", async ({ page }) => {
    await gotoMeter(page);
    const meter = page.locator(METER).first();

    const before = await meter.getAttribute("aria-label");
    await page.waitForTimeout(2200);
    expect(await meter.getAttribute("aria-label")).not.toBe(before);
  });

  test("nothing transitions", async ({ page }) => {
    await gotoMeter(page);

    // Parsed rather than string-matched: the stylesheet says 0.01ms, the
    // browser reports it in seconds as 0.00001s.
    const slow = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .flatMap((el) => {
          const style = getComputedStyle(el);
          return [style.transitionDuration, style.animationDuration];
        })
        .flatMap((value) => value.split(",").map((v) => v.trim()))
        .filter((v) => v.endsWith("s"))
        .map((v) => (v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000))
        .filter((ms) => ms > 1),
    );

    expect(slow).toEqual([]);
  });
});

test("time is amber, and the ticking seconds are brighter", async ({ page }) => {
  await gotoMeter(page);
  const meter = page.locator(METER).first();

  const colours = await meter.evaluate((el) =>
    Array.from(el.querySelectorAll("div"))
      .filter((d) => /^\d{2}$/.test(d.textContent?.trim() ?? ""))
      .map((d) => getComputedStyle(d).color),
  );

  expect(colours).toHaveLength(3);
  expect(colours[0]).toBe(AMBER);
  expect(colours[1]).toBe(AMBER);
  // The seconds are the only moving element, so the only brighter one.
  expect(colours[2]).toBe(AMBER_BRIGHT);
});

// A rental about to expire does not turn red. Urgency is the size of the digits.
test("nothing in the meter is red or green", async ({ page }) => {
  await gotoMeter(page);
  const forbidden = await page
    .locator(METER)
    .first()
    .evaluate((el) => {
      const banned = ["rgb(196, 0, 0)", "rgb(0, 160, 0)"];
      return Array.from(el.querySelectorAll("*")).filter((n) => {
        const s = getComputedStyle(n);
        return banned.includes(s.color) || banned.includes(s.backgroundColor);
      }).length;
    });
  expect(forbidden).toBe(0);
});

test("every changing number is tabular, so digits do not reflow", async ({ page }) => {
  await gotoMeter(page);
  const nonTabular = await page
    .locator(METER)
    .first()
    .evaluate(
      (el) =>
        Array.from(el.querySelectorAll("div"))
          .filter((d) => /^\d{2}$/.test(d.textContent?.trim() ?? ""))
          .filter((d) => !getComputedStyle(d).fontVariantNumeric.includes("tabular-nums")).length,
    );
  expect(nonTabular).toBe(0);
});

test("the depletion bar reflects the proportion left", async ({ page }) => {
  await gotoMeter(page);
  const meter = page.locator(METER).first();

  const label = await meter.getAttribute("aria-label");
  const match = label!.match(/(\d+) hours (\d+) minutes/)!;
  const remainingH = Number(match[1]) + Number(match[2]) / 60;

  const percentText = await meter.locator("text=/% LEFT/").textContent();
  const percent = Number(percentText!.replace(/[^\d]/g, ""));

  // The panel is a six-hour rental; the bar is derived from the window, not
  // from a stored percentage that could disagree with the clock beside it.
  expect(percent).toBeGreaterThan(Math.floor((remainingH / 6) * 100) - 2);
  expect(percent).toBeLessThan(Math.ceil((remainingH / 6) * 100) + 2);
});

test("is legible and unmissable at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await gotoMeter(page);

  const digitSize = await page
    .locator(METER)
    .first()
    .evaluate((el) => {
      const d = Array.from(el.querySelectorAll("div")).find((n) =>
        /^\d{2}$/.test(n.textContent?.trim() ?? ""),
      )!;
      return parseFloat(getComputedStyle(d).fontSize);
    });

  // The boldest type on the page, even at the narrowest width.
  expect(digitSize).toBeGreaterThanOrEqual(34);

  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
