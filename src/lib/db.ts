import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { serverConfig } from "@/lib/config/server";

// Held on globalThis rather than in a module-local, because Next.js hot-reloads
// modules in development and each reload would otherwise open a fresh pool until
// Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * The Prisma client — one per process, created on first use.
 *
 * Lazy rather than instantiated at module load so that `next build` can collect
 * page data without a database URL; a build machine should not need production
 * secrets. `instrumentation.ts` validates config at server startup, so a running
 * server still fails immediately rather than on the first query.
 *
 * The cache is unconditional. An earlier version only cached outside production,
 * which meant production built a new client — and a new pg pool — on every call,
 * several times per board render. Nothing caught it because tests never run with
 * NODE_ENV=production.
 *
 * Prisma 7 connects through a driver adapter; the CLI reads its own URL from
 * prisma.config.ts.
 */
export function getDb(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;

  const { DATABASE_URL } = serverConfig();
  globalForPrisma.prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  return globalForPrisma.prisma;
}

/** Round-trips a trivial query. Used by the health check and by the scaffold test. */
export async function checkDatabaseConnection(): Promise<boolean> {
  await getDb().$queryRaw`SELECT 1`;
  return true;
}
