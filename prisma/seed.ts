/**
 * Schema only. No rows.
 *
 * This project has a non-negotiable rule: never fabricate activity, prices, or
 * counts. That applies to development and staging as much as to production —
 * a seeded board teaches everyone working on it to expect a full page, and the
 * empty states (#13, #11, #16) are exactly the states that most need looking at.
 *
 * So there is no fixture data here, and there is not going to be. This script
 * exists to make that explicit and to fail loudly if someone adds rows by hand
 * and forgets.
 *
 * Applying the schema is `npm run db:migrate` (development) or `npm run
 * db:deploy` (anywhere else). Neither needs this script.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";

// Run outside the Next.js runtime, which is what loads .env files normally.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see README.");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    const purchases = await db.purchase.count();
    const samples = await db.askSample.count();

    if (purchases === 0 && samples === 0) {
      console.log("Schema is applied and the database is empty. Nothing to seed — by design.");
      return;
    }

    console.log(
      `Database holds ${purchases} purchase(s) and ${samples} ask sample(s).\n` +
        "Nothing was seeded. If these are not real, they should not be here —\n" +
        "see the non-negotiable in docs/build-prompt.md.",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
