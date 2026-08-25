import { expect, test } from "@playwright/test";

/**
 * The hourly job endpoint (#22). An open scheduler endpoint is an
 * unauthenticated write to the market series, so the auth is what is tested
 * here — the job's behaviour is covered by unit tests against a real database.
 */

test("refuses an unauthenticated run", async ({ request }) => {
  const response = await request.post("/api/cron/hourly");
  expect(response.status()).toBe(401);
});

test("refuses a wrong secret", async ({ request }) => {
  const response = await request.post("/api/cron/hourly", {
    headers: { authorization: "Bearer not-the-secret" },
  });
  expect(response.status()).toBe(401);
});

test("refuses a secret that is a prefix of the real one", async ({ request }) => {
  const response = await request.post("/api/cron/hourly", {
    headers: { authorization: "Bearer 0123456789" },
  });
  expect(response.status()).toBe(401);
});

test("refuses the status endpoint unauthenticated", async ({ request }) => {
  const response = await request.get("/api/cron/hourly");
  expect(response.status()).toBe(401);
});
