import "server-only";

import { z } from "zod";

/**
 * Server-side configuration, validated once at boot.
 *
 * Everything in here is server-only. Nothing declared in this file may be read
 * from a client component — `server-only` makes that a build error rather than a
 * leaked secret. Values that genuinely belong in the browser go in ./client.ts
 * and carry the NEXT_PUBLIC_ prefix.
 *
 * Variables are added by the issue that needs them, not up front — a required
 * variable nothing reads yet would block startup for no reason. Current owners:
 *
 *   Stripe (#26)            STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   Admin auth (#17)        ADMIN_*
 *   Rate limiting (#18)     RATE_LIMIT_*
 *   Avatar / oEmbed (#19,#20)
 */

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Prisma connects through the pg driver adapter; see src/lib/db.ts.
  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
      "DATABASE_URL must be a postgres:// or postgresql:// connection string",
    ),

  // Absolute origin the app is served from. Used for Stripe redirects (#26) and
  // for building the canonical target links the board renders.
  APP_URL: z.url({ error: "APP_URL must be an absolute URL, e.g. http://127.0.0.1:3000" }),

  // Authenticates the hourly job endpoint (#22). An open scheduler endpoint is
  // an unauthenticated write. Long enough that guessing is not worth trying.
  CRON_SECRET: z
    .string({ error: "CRON_SECRET is required" })
    .min(32, "CRON_SECRET must be at least 32 characters"),
});

export type ServerConfig = z.infer<typeof serverSchema>;

/**
 * Formats a Zod failure as something a human can act on without reading a stack
 * trace — the whole point of validating at boot rather than at first use.
 */
function describeFailure(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    return `  ${name}: ${issue.message}`;
  });
  return [
    "Invalid server environment configuration:",
    ...lines,
    "",
    "Copy .env.example to .env.local and fill in the missing values — see README.",
  ].join("\n");
}

export function parseServerConfig(source: Record<string, string | undefined>): ServerConfig {
  const result = serverSchema.safeParse(source);
  if (!result.success) {
    throw new Error(describeFailure(result.error));
  }
  return result.data;
}

let cached: ServerConfig | undefined;

/**
 * Lazily parsed and then cached.
 *
 * Lazy rather than parsed at module load so that `next build` does not require
 * production secrets to be present on the build machine. `instrumentation.ts`
 * calls this at server startup, so a running server still fails loudly and
 * immediately rather than at the first request that happens to need a value.
 */
export function serverConfig(): ServerConfig {
  cached ??= parseServerConfig(process.env);
  return cached;
}
