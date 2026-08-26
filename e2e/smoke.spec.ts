import { expect, test } from "@playwright/test";

// Proves the scaffold boots and serves at every width the fidelity pass (#5)
// is held against. Real page assertions arrive with the board in #6.
test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "TopNow" })).toBeVisible();
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
