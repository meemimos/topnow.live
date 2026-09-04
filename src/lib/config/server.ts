import "server-only";

import { z } from "zod";

import { parsePolicy, type Policy } from "@/lib/limit/policy";

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

  /**
   * Stripe (#26).
   *
   * Placeholders are accepted so the app boots and the whole payment path can be
   * exercised without credentials — every test signs its own webhooks. What a
   * placeholder cannot do is talk to Stripe, so `stripeConfigured()` below is
   * what gates any real API call.
   */
  STRIPE_SECRET_KEY: z.string({ error: "STRIPE_SECRET_KEY is required" }).min(1),
  STRIPE_WEBHOOK_SECRET: z.string({ error: "STRIPE_WEBHOOK_SECRET is required" }).min(1),

  /**
   * Rate limits (#18), one per protected surface.
   *
   * Written as `count/window+burst` — see src/lib/limit/policy.ts, which is also
   * where the argument for the burst being part of the syntax lives. Parsed here
   * so a malformed limit stops the server at boot rather than at the first
   * request that happens to be limited.
   *
   * The defaults are deliberately generous. A limit that catches a real person
   * is worse than one that lets an abuser through, because the queued-hours cap
   * (#24) already bounds what flooding the queue can achieve — the limiter is
   * protecting API quota and third-party budgets, not standing in for the cap.
   */
  RATE_LIMIT_CHECKOUT: policy("20/1h+5"),
  RATE_LIMIT_REPORT: policy("10/1h+3"),
  RATE_LIMIT_AVATAR: policy("120/1h+20"),
  RATE_LIMIT_EMBED: policy("120/1h+20"),
  /** Stricter, and on authentication attempts specifically. */
  RATE_LIMIT_ADMIN: policy("10/15m+5"),

  /**
   * How many proxies sit in front of the app.
   *
   * Decides which `x-forwarded-for` entry a limit is keyed on — see
   * src/lib/limit/address.ts. Wrong in one direction it trusts text the client
   * wrote; wrong in the other it buckets everybody together. It is configuration
   * because only the deployment knows the answer.
   */
  RATE_LIMIT_TRUSTED_PROXIES: z.coerce.number().int().min(1).max(8).default(1),
});

/**
 * A rate-limit policy, parsed from its compact string form.
 *
 * `z.string().default(...).transform(...)` rather than a plain string, so the
 * value the rest of the app sees is already a validated policy and there is no
 * second place where a limit could be parsed differently.
 */
function policy(fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((text, ctx): Policy => {
      try {
        return parsePolicy(text);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "invalid rate limit",
        });
        return z.NEVER;
      }
    });
}

/** Values that exist to let the app boot, and must never reach Stripe. */
const PLACEHOLDER_MARKER = "placeholder";

/**
 * Whether the Stripe keys are real.
 *
 * False while the repo is running on placeholders, which is the state until the
 * keys are supplied as environment variables and api.stripe.com is reachable.
 * Anything that would make a network call to Stripe checks this first and says
 * so plainly rather than failing with an authentication error.
 */
export function stripeConfigured(): boolean {
  const { STRIPE_SECRET_KEY } = serverConfig();
  return !STRIPE_SECRET_KEY.includes(PLACEHOLDER_MARKER);
}

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
