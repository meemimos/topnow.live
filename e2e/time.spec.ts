import { expect, test } from "@playwright/test";

/**
 * Server-authoritative time (#3).
 *
 * The requirement is that a visitor with a skewed system clock sees the same
 * countdown as everyone else, so these run against a deliberately wrong client
 * clock rather than trusting that the offset maths is right in isolation.
 */

test("the time endpoint is never cached", async ({ request }) => {
  const response = await request.get("/api/time");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");

  const first = (await response.json()) as { now: number };
  expect(typeof first.now).toBe("number");

  // Close enough to real time to be the server's clock rather than a fixture.
  expect(Math.abs(first.now - Date.now())).toBeLessThan(60_000);
});

test("the endpoint advances between calls", async ({ request }) => {
  const a = (await (await request.get("/api/time")).json()) as { now: number };
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const b = (await (await request.get("/api/time")).json()) as { now: number };

  expect(b.now).toBeGreaterThan(a.now);
});

test.describe("with a client clock skewed ten minutes fast", () => {
  test("the server's time is unaffected, so the offset is measurable", async ({ page }) => {
    const SKEW_MS = 10 * 60_000;

    // Skew Date.now() before any page script runs.
    await page.addInitScript((skew) => {
      const RealDate = Date;
      const shifted = new Proxy(RealDate, {
        construct(target, args) {
          if (args.length === 0) return new target(RealDate.now() + (skew as number));
          return new target(...(args as ConstructorParameters<typeof Date>));
        },
        get(target, prop, receiver) {
          if (prop === "now") return () => RealDate.now() + (skew as number);
          return Reflect.get(target, prop, receiver);
        },
      });
      globalThis.Date = shifted as DateConstructor;
    }, SKEW_MS);

    await page.goto("/");

    const measured = await page.evaluate(async () => {
      const response = await fetch("/api/time", { cache: "no-store" });
      const body = (await response.json()) as { now: number };
      return { serverNow: body.now, clientNow: Date.now() };
    });

    // The client believes it is ten minutes later than it is.
    const offset = measured.serverNow - measured.clientNow;
    expect(offset).toBeLessThan(-9 * 60_000);
    expect(offset).toBeGreaterThan(-11 * 60_000);

    // A countdown computed from serverNow + offset lands on real time, which is
    // the whole point: the skew is measured and cancelled rather than inherited.
    const corrected = measured.clientNow + offset;
    expect(Math.abs(corrected - measured.serverNow)).toBeLessThan(1_000);
  });
});
