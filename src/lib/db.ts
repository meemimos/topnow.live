import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma 7 connects through a driver adapter rather than a `url` in the schema.
 *
 * DATABASE_URL is read directly here because the validated config module is #23;
 * this is the one place that will keep a bare read, and it moves behind the
 * config module when that lands.
 */
function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in — see README.",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

// Next.js hot-reloads modules in development, which would otherwise open a new
// pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

/** Round-trips a trivial query. Used by the health check and by the scaffold test. */
export async function checkDatabaseConnection(): Promise<boolean> {
  await db.$queryRaw`SELECT 1`;
  return true;
}
