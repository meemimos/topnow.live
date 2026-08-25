import { describe, expect, it } from "vitest";

import { checkDatabaseConnection } from "./db";

// Proves the scaffold's Prisma wiring reaches a real Postgres. It is the only
// test here that needs a database; everything from #2 onward is pure.
describe("database connection", () => {
  it("round-trips a query against Postgres", async () => {
    await expect(checkDatabaseConnection()).resolves.toBe(true);
  });
});
