import { z } from "zod";

/**
 * Configuration that is safe to ship to the browser.
 *
 * Next.js inlines `process.env.NEXT_PUBLIC_*` at build time only when it is
 * written as a literal member expression, so each variable must be spelled out
 * below. A computed lookup (`process.env[name]`) silently yields undefined in
 * client bundles.
 *
 * Nothing secret goes here. If a value should not appear in view-source, it
 * belongs in ./server.ts.
 */

const clientSchema = z.object({
  // Decision D3: the market panel stays hidden until a slot has 20h of sampled
  // ask (#22). This flag is what #12 gates the panel on.
  NEXT_PUBLIC_MARKET_PANEL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export type ClientConfig = z.infer<typeof clientSchema>;

const rawClientEnv = {
  NEXT_PUBLIC_MARKET_PANEL_ENABLED: process.env.NEXT_PUBLIC_MARKET_PANEL_ENABLED,
};

export function parseClientConfig(source: Record<string, string | undefined>): ClientConfig {
  const result = clientSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(["Invalid public environment configuration:", ...lines].join("\n"));
  }
  return result.data;
}

/**
 * Parsed at module load. Unlike the server config this needs no secrets, so
 * there is nothing to defer and a bad value should break the build.
 */
export const clientConfig: ClientConfig = parseClientConfig(rawClientEnv);
