import { expect, test } from "@playwright/test";

// Proves the app boots and serves at every width the fidelity pass (#5) is held
// against. The board's own behaviour is covered in board.spec.ts, which needs
// database state; this only asserts the page is there.
test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Rent the top spot/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "The board" })).toBeVisible();
});

test("home page does not scroll horizontally", async ({ page }) => {
  await page.goto("/");
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
});

test("health check reports the database is up", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "ok", database: "up" });
});
