import { expect, test } from "@playwright/test";

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
  await page.goto("/dev/primitives");
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe(EXPECTED.ground);
});

test("nothing has a rounded corner", async ({ page }) => {
  await page.goto("/dev/primitives");
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
  await page.goto("/dev/primitives");

  const plateShadow = await page
    .locator("text=raised")
    .first()
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(plateShadow).toContain("inset");
  expect(plateShadow).toContain("-2px -2px");

  const buttonShadow = await page
    .getByRole("button", { name: "TAKE SLOT 01 — $25.50" })
    .evaluate((el) => getComputedStyle(el).boxShadow);
  expect(buttonShadow).toContain("-3px -3px");
});

test("Silkscreen is applied to labels and is self-hosted", async ({ page }) => {
  const fontRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fontRequests.push(request.url());
  });

  await page.goto("/dev/primitives");
  await page.evaluate(() => document.fonts.ready);

  const family = await page
    .getByRole("button", { name: "TAKE SLOT 01 — $25.50" })
    .evaluate((el) => getComputedStyle(el).fontFamily);
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
  await page.goto("/dev/primitives");

  const button = page.getByRole("button", { name: "TAKE SLOT 01 — $25.50" });
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
  await page.goto("/dev/primitives");
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
  await page.goto("/dev/primitives");

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
  await page.goto("/dev/primitives");
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
