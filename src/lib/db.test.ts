import { describe, expect, it } from "vitest";

import { checkDatabaseConnection, getDb } from "./db";

// Proves the scaffold's Prisma wiring reaches a real Postgres. It is the only
// test here that needs a database; everything from #2 onward is pure.
describe("database connection", () => {
  it("round-trips a query against Postgres", async () => {
    await expect(checkDatabaseConnection()).resolves.toBe(true);
  });

  /**
   * One client per process, whatever the environment.
   *
   * An earlier version cached only outside production, so production opened a
   * new client and a new pg pool on every call — several per board render, and
   * connection exhaustion within a handful of requests. Tests never run with
   * NODE_ENV=production, so nothing caught it.
   */
  it("returns the same client on every call", () => {
    expect(getDb()).toBe(getDb());
  });
});
