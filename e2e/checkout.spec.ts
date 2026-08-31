import { expect, test, type Page } from "@playwright/test";

/**
 * The checkout form (#8).
 *
 * Stateless against the database — every assertion here is about the form's own
 * rules — so unlike board.spec.ts this runs at all three widths.
 */

const HANDLE_INPUT = 'input[aria-describedby="derived-url"]';

async function gotoCheckout(page: Page) {
  await page.goto("/checkout", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
}

test("platform is chosen before the handle", async ({ page }) => {
  await gotoCheckout(page);

  // The platform control precedes the handle in the document, and the handle
  // field's prefix comes from whichever platform is selected.
  const order = await page.evaluate(() => {
    const select = document.querySelector("select")!;
    const handle = document.querySelector('input[aria-describedby="derived-url"]')!;
    return select.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING
      ? "after"
      : "before";
  });
  expect(order).toBe("after");
});

test("the target link is derived, and there is no field to type one into", async ({ page }) => {
  await gotoCheckout(page);
  await page.fill(HANDLE_INPUT, "mira-builds");

  await expect(page.locator("#derived-url")).toHaveText(/github\.com\/mira-builds/);

  // The helper text is text. Nothing on the page accepts a URL for a handle
  // platform — a field a user can type any link into is an abuse vector (#17).
  const urlInputs = await page.locator('input[type="url"]').count();
  expect(urlInputs).toBe(0);
});

test("the derived link follows the platform", async ({ page }) => {
  await gotoCheckout(page);
  await page.fill(HANDLE_INPUT, "parcelkit");

  await page.selectOption("select", "youtube");
  await expect(page.locator("#derived-url")).toHaveText(/youtube\.com\/@parcelkit/);

  await page.selectOption("select", "reddit");
  await expect(page.locator("#derived-url")).toHaveText(/reddit\.com\/user\/parcelkit/);
});

test("website swaps the handle for a URL and a display name", async ({ page }) => {
  await gotoCheckout(page);
  await page.selectOption("select", "web");

  await expect(page.locator(HANDLE_INPUT)).toHaveCount(0);
  await expect(page.locator('input[type="url"]')).toBeVisible();
  await expect(page.getByText("Display name")).toBeVisible();
});

test("the display name is capped at 24 characters", async ({ page }) => {
  await gotoCheckout(page);
  await page.selectOption("select", "web");

  const input = page.getByText("Display name").locator("..").locator("input");
  await input.fill("x".repeat(40));
  expect((await input.inputValue()).length).toBe(24);
});

test("the tagline counter is live from the first keystroke", async ({ page }) => {
  await gotoCheckout(page);
  const tagline = page.getByText("One line of copy").locator("..").locator("input");

  await expect(page.getByText("60 characters left")).toBeVisible();
  await tagline.fill("Hello");
  await expect(page.getByText("55 characters left")).toBeVisible();
});

test("the tagline is capped at 60 characters", async ({ page }) => {
  await gotoCheckout(page);
  const tagline = page.getByText("One line of copy").locator("..").locator("input");
  await tagline.fill("x".repeat(90));
  expect((await tagline.inputValue()).length).toBe(60);
});

test("the duration slider can only land on a snap point", async ({ page }) => {
  await gotoCheckout(page);
  const slider = page.getByRole("slider", { name: "Duration" });

  await expect(slider).toHaveAttribute("step", "1");
  await expect(slider).toHaveAttribute("max", "4");

  // Arrow keys move between snap points, never between them.
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveAttribute("aria-valuetext", /6 hours/);
  await page.keyboard.press("ArrowLeft");
  await expect(slider).toHaveAttribute("aria-valuetext", /3 hours/);
});

test("slot buttons are a keyboard-operable radio group", async ({ page }) => {
  await gotoCheckout(page);
  const group = page.getByRole("radiogroup", { name: "Slot" });
  await expect(group).toBeVisible();

  const slotTwo = page.getByRole("radio", { name: "02" });
  await slotTwo.click();
  await expect(slotTwo).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "01" })).toHaveAttribute("aria-checked", "false");
});

test("the server re-validates and says what the requirement is", async ({ page }) => {
  await gotoCheckout(page);

  await page.fill(HANDLE_INPUT, "-nope");
  await page.getByText("One line of copy").locator("..").locator("input").fill("A tagline.");
  await page.getByRole("button", { name: "CONTINUE" }).click();

  // Specific, never "invalid input".
  const alert = page.locator('[role="alert"]').first();
  await expect(alert).toContainText(/letters, numbers and single hyphens/);
});

test("a valid listing is priced by the server", async ({ page }) => {
  await gotoCheckout(page);

  await page.fill(HANDLE_INPUT, "mira-builds");
  await page.getByText("One line of copy").locator("..").locator("input").fill("A tagline.");
  await page.getByRole("button", { name: "CONTINUE" }).click();

  // The receipt appears with figures from the pricing engine, not from the form.
  // Its content is asserted in detail by receipt.spec.ts, which owns the queue
  // state those figures depend on.
  await expect(page.getByText("TOPNOW RECEIPT")).toBeVisible();
  await expect(page.getByText(/H AT \$[\d.]+\/HR/)).toBeVisible();
});

test("no horizontal scroll at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await gotoCheckout(page);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});
