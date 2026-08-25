import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { serverConfig } from "@/lib/config/server";

// Next.js hot-reloads modules in development, which would otherwise open a new
// pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * The Prisma client, created on first use.
 *
 * Lazy rather than instantiated at module load so that `next build` can collect
 * page data without a database URL — a build machine should not need production
 * secrets. `instrumentation.ts` validates config at server startup, so a running
 * server still fails immediately rather than on the first query.
 *
 * Prisma 7 connects through a driver adapter; the CLI reads its own URL from
 * prisma.config.ts.
 */
export function getDb(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const { DATABASE_URL, NODE_ENV } = serverConfig();
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });

  if (NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

/** Round-trips a trivial query. Used by the health check and by the scaffold test. */
export async function checkDatabaseConnection(): Promise<boolean> {
  await getDb().$queryRaw`SELECT 1`;
  return true;
}
