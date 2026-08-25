import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

// Next.js loads .env.local automatically; the Prisma CLI does not, so load it
// here with the same precedence Next uses (.env.local overrides .env).
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

// The CLI's connection URL for migrations and introspection. The runtime client
// gets its own connection through the driver adapter in src/lib/db.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
