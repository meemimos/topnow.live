import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";

import { consume, pruneExpiredLimits } from "./limiter";
import { parsePolicy } from "./policy";

/**
 * The rate limiter (#18).
 *
 * Two things are being proved here, and they pull in opposite directions: that
 * an abuser is actually stopped, and that a real person doing something twice is
 * not. A limiter that only satisfies the first is easy and is the reason so many
 * of them get quietly raised until they do nothing.
 */

const db = getDb();
const SALT = "test-salt";

/** Distinct per test, so one test's spent bucket is not another's starting state. */
let counter = 0;
function freshIdentity(): string {
  counter += 1;
  return `caller-${counter}-${Math.random().toString(36).slice(2)}`;
}

beforeEach(async () => {
  await db.rateLimit.deleteMany();
});

afterAll(async () => {
  await db.rateLimit.deleteMany();
});

describe("spending a budget", () => {
  it("allows the burst back-to-back", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const now = new Date("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      const decision = await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
      expect(decision.allowed, `request ${i + 1} of the burst`).toBe(true);
    }
  });

  it("refuses the one after the burst", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const now = new Date("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
    }

    const refused = await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
    expect(refused.allowed).toBe(false);
  });

  it("does not block someone correcting a typo and resubmitting", async () => {
    // The issue's last acceptance line. Three submissions three seconds apart is
    // a person, not an attack, and a limiter that catches them is worse than no
    // limiter because it is the one that gets switched off.
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const start = Date.parse("2026-09-04T10:00:00Z");

    for (const offset of [0, 3_000, 6_000]) {
      const decision = await consume({
        bucket: "checkout",
        identity,
        policy,
        now: new Date(start + offset),
        salt: SALT,
      });
      expect(decision.allowed, `submission at +${offset}ms`).toBe(true);
    }
  });

  it("lets the caller back in after the window, and not before", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const start = Date.parse("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now: new Date(start), salt: SALT });
    }

    // One emission short of recovered.
    const early = await consume({
      bucket: "checkout",
      identity,
      policy,
      now: new Date(start + policy.emissionMs - 1_000),
      salt: SALT,
    });
    expect(early.allowed).toBe(false);

    const later = await consume({
      bucket: "checkout",
      identity,
      policy,
      now: new Date(start + policy.emissionMs),
      salt: SALT,
    });
    expect(later.allowed).toBe(true);
  });

  it("recovers a token at a time rather than resetting the whole budget", async () => {
    // The failure a fixed window has: spend N at 10:59, spend N again at 11:00.
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const start = Date.parse("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now: new Date(start), salt: SALT });
    }

    const at = new Date(start + policy.emissionMs);
    expect(
      (await consume({ bucket: "checkout", identity, policy, now: at, salt: SALT })).allowed,
    ).toBe(true);
    // One emission bought exactly one request back, not five.
    expect(
      (await consume({ bucket: "checkout", identity, policy, now: at, salt: SALT })).allowed,
    ).toBe(false);
  });

  it("refills completely after a quiet window", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const start = Date.parse("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now: new Date(start), salt: SALT });
    }

    const nextDay = new Date(start + 86_400_000);
    for (let i = 0; i < 5; i += 1) {
      const decision = await consume({
        bucket: "checkout",
        identity,
        policy,
        now: nextDay,
        salt: SALT,
      });
      expect(decision.allowed).toBe(true);
    }
  });
});

describe("Retry-After", () => {
  it("says when the next request actually gets through", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const now = new Date("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
    }
    const refused = await consume({ bucket: "checkout", identity, policy, now, salt: SALT });

    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(policy.emissionMs);

    // And waiting exactly that long works — which is what makes it a promise
    // rather than a number chosen to sound discouraging.
    const after = await consume({
      bucket: "checkout",
      identity,
      policy,
      now: new Date(now.getTime() + refused.retryAfterMs),
      salt: SALT,
    });
    expect(after.allowed).toBe(true);
  });

  it("is zero when the request was allowed", async () => {
    const policy = parsePolicy("20/1h+5");
    const decision = await consume({
      bucket: "checkout",
      identity: freshIdentity(),
      policy,
      salt: SALT,
    });
    expect(decision).toMatchObject({ allowed: true, retryAfterMs: 0 });
  });
});

describe("who shares a budget", () => {
  it("keeps two callers apart", async () => {
    const policy = parsePolicy("20/1h+1");
    const now = new Date("2026-09-04T10:00:00Z");
    const mine = freshIdentity();
    const theirs = freshIdentity();

    await consume({ bucket: "checkout", identity: mine, policy, now, salt: SALT });
    expect(
      (await consume({ bucket: "checkout", identity: mine, policy, now, salt: SALT })).allowed,
    ).toBe(false);
    // Spending my budget must not spend anyone else's.
    expect(
      (await consume({ bucket: "checkout", identity: theirs, policy, now, salt: SALT })).allowed,
    ).toBe(true);
  });

  it("keeps two buckets apart for one caller", async () => {
    const policy = parsePolicy("20/1h+1");
    const now = new Date("2026-09-04T10:00:00Z");
    const identity = freshIdentity();

    await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
    // Hitting the checkout limit must not lock the same person out of reporting
    // abuse — the two exist for opposite reasons.
    expect((await consume({ bucket: "report", identity, policy, now, salt: SALT })).allowed).toBe(
      true,
    );
  });

  it("shares one budget across two instances", async () => {
    // The acceptance line that rules out an in-process limiter. These two
    // clients share no memory, exactly as two servers do not; if the budget
    // lived in the process, the second would start with a full one.
    const { DATABASE_URL } = serverConfig();
    const first = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
    const second = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

    try {
      const policy = parsePolicy("20/1h+2");
      const identity = freshIdentity();
      const now = new Date("2026-09-04T10:00:00Z");

      const a = await consume({ bucket: "checkout", identity, policy, now, salt: SALT, db: first });
      const b = await consume({
        bucket: "checkout",
        identity,
        policy,
        now,
        salt: SALT,
        db: second,
      });
      const c = await consume({ bucket: "checkout", identity, policy, now, salt: SALT, db: first });

      expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, false]);
    } finally {
      await first.$disconnect();
      await second.$disconnect();
    }
  });

  it("hands out exactly one token when two requests race for it", async () => {
    // The reason the decision is one UPDATE rather than a read and then a write:
    // in the gap between those two, both callers see the same budget.
    const policy = parsePolicy("20/1h+1");
    const identity = freshIdentity();
    const now = new Date("2026-09-04T10:00:00Z");

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        consume({ bucket: "checkout", identity, policy, now, salt: SALT }),
      ),
    );

    expect(results.filter((decision) => decision.allowed)).toHaveLength(1);
  });
});

describe("what is stored", () => {
  it("never writes the identity down", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = "198.51.100.7";
    await consume({ bucket: "checkout", identity, policy, salt: SALT });

    const rows = await db.rateLimit.findMany();
    expect(rows).toHaveLength(1);
    // A limiter that quietly accumulates a log of visitor addresses is a privacy
    // regression bolted to a safety feature.
    expect(rows[0]!.key).not.toContain(identity);
    expect(rows[0]!.key).toMatch(/^checkout:[0-9a-f]{40}$/);
  });

  it("cannot be linked back without the server secret", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = "198.51.100.7";

    await consume({ bucket: "checkout", identity, policy, salt: "one-salt" });
    await consume({ bucket: "checkout", identity, policy, salt: "another-salt" });

    const keys = (await db.rateLimit.findMany()).map((row) => row.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("when the store is unreachable", () => {
  it("lets the request through on the paths that protect a budget", async () => {
    const policy = parsePolicy("20/1h+5");
    vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));

    // If Postgres is down then checkout is already broken; refusing here would
    // turn an outage into a second, more confusing outage.
    const decision = await consume({
      bucket: "checkout",
      identity: freshIdentity(),
      policy,
      salt: SALT,
    });
    expect(decision.allowed).toBe(true);
    vi.restoreAllMocks();
  });

  it("refuses on the path where the limiter is the control", async () => {
    const policy = parsePolicy("10/15m+5");
    vi.spyOn(db, "$queryRaw").mockRejectedValueOnce(new Error("connection refused"));

    // Admin sign-in. An outage must not be a way to turn off the limit on
    // password guessing.
    const decision = await consume({
      bucket: "admin",
      identity: freshIdentity(),
      policy,
      salt: SALT,
      onFailure: "deny",
    });
    expect(decision.allowed).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("pruneExpiredLimits", () => {
  it("drops buckets that have refilled", async () => {
    const policy = parsePolicy("20/1h+5");
    const now = new Date("2026-09-04T10:00:00Z");
    await consume({ bucket: "checkout", identity: freshIdentity(), policy, now, salt: SALT });

    expect(await db.rateLimit.count()).toBe(1);
    expect(await pruneExpiredLimits(new Date(now.getTime() + 86_400_000))).toBe(1);
    expect(await db.rateLimit.count()).toBe(0);
  });

  it("keeps a bucket that is still holding somebody back", async () => {
    const policy = parsePolicy("20/1h+5");
    const identity = freshIdentity();
    const now = new Date("2026-09-04T10:00:00Z");

    for (let i = 0; i < 5; i += 1) {
      await consume({ bucket: "checkout", identity, policy, now, salt: SALT });
    }

    // Pruning here would hand a spent caller a full budget, which is the silent
    // way a limiter stops limiting.
    expect(await pruneExpiredLimits(new Date(now.getTime() + 60_000))).toBe(0);
    expect((await consume({ bucket: "checkout", identity, policy, now, salt: SALT })).allowed).toBe(
      false,
    );
  });
});
