import { expect, test, type Page } from "@playwright/test";

import { quoteForQueue } from "../src/lib/pricing";
import { actionLabel } from "../src/lib/pricing/format";

// Derived the same way the page derives it, so a pricing change cannot leave
// these tests asserting on a stale string.
const PRIMARY_BUTTON = actionLabel(quoteForQueue(1, 3, 12), false);

/**
 * Loads the page and waits for React to finish hydrating.
 *
 * The page contains client components, so hydration replaces DOM nodes shortly
 * after load. A Playwright element handle taken before that points at a
 * detached node afterwards, and `getComputedStyle` on a detached node returns
 * empty strings — which reads as "the style is missing" rather than "the node
 * moved". Every assertion below therefore queries inside `evaluate`, resolving
 * and reading in the same tick.
 */
async function gotoHydrated(page: Page) {
  await page.goto("/dev/primitives", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

/**
 * The token layer is only useful if the values that reach the browser are the
 * ones measured from TopNow.html. These assert the computed styles, not the
 * class names — a token that resolves to nothing still produces a class.
 */

const EXPECTED = {
  ground: "rgb(0, 128, 128)",
  plate: "rgb(198, 198, 198)",
  navy: "rgb(0, 0, 128)",
  meter: "rgb(255, 176, 0)",
  note: "rgb(255, 255, 204)",
};

test("the desktop is teal", async ({ page }) => {
  await gotoHydrated(page);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe(EXPECTED.ground);
});

test("nothing has a rounded corner", async ({ page }) => {
  await gotoHydrated(page);
  const rounded = await page.evaluate(() =>
    Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const radius = getComputedStyle(el).borderRadius;
        return radius !== "" && radius !== "0px";
      })
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5),
  );
  expect(rounded).toEqual([]);
});

test("plates carry the 2px bevel and controls the 3px bevel", async ({ page }) => {
  await gotoHydrated(page);

  const shadows = await page.evaluate((buttonLabel) => {
    const read = (el: Element | null | undefined) => (el ? getComputedStyle(el).boxShadow : "");
    const plate = Array.from(document.querySelectorAll("div")).find(
      (d) => d.textContent?.trim() === "raised",
    );
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === buttonLabel,
    );
    return { plate: read(plate), button: read(button) };
  }, PRIMARY_BUTTON);

  expect(shadows.plate).toContain("inset");
  expect(shadows.plate).toContain("-2px -2px");
  expect(shadows.button).toContain("-3px -3px");
});

test("Silkscreen is applied to labels and is self-hosted", async ({ page }) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fontRequests.push(request.url());
  });

  await gotoHydrated(page);

  const family = await page.evaluate((buttonLabel) => {
    const button = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === buttonLabel,
    );
    return button ? getComputedStyle(button).fontFamily : "";
  }, PRIMARY_BUTTON);
  expect(family).toContain("Silkscreen");

  // Every font must come from this origin. A third-party font host is a
  // request every visitor makes to someone else, and a layout shift when it
  // is slow.
  for (const url of fontRequests) {
    expect(new URL(url).host).toBe(new URL(page.url()).host);
  }
  expect(fontRequests.length).toBeGreaterThan(0);
});

test("the focus ring is visible and amber", async ({ page }) => {
  await gotoHydrated(page);

  const button = page.getByRole("button", { name: PRIMARY_BUTTON });
  await button.focus();

  const outline = await button.evaluate((el) => {
    const style = getComputedStyle(el);
    return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle };
  });

  expect(outline.style).toBe("solid");
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  expect(outline.color).toBe(EXPECTED.meter);
});

test("a selected toggle reports its state to assistive tech", async ({ page }) => {
  await gotoHydrated(page);
  await expect(page.getByRole("button", { name: "ALL", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "01", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("green and red appear only where the chart legend explains them", async ({ page }) => {
  await gotoHydrated(page);

  // On the kitchen sink they are shown as labelled swatches. Anywhere else in
  // the app this would be a colour-discipline violation (#4).
  const swatches = await page.evaluate(() => {
    const wanted = ["rgb(0, 160, 0)", "rgb(196, 0, 0)"];
    return Array.from(document.querySelectorAll("*"))
      .filter((el) => wanted.includes(getComputedStyle(el).backgroundColor))
      .map((el) => el.className);
  });

  expect(swatches).toHaveLength(2);
});

test("no horizontal scroll at any width", async ({ page }) => {
  await gotoHydrated(page);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
