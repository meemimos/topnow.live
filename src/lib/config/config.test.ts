import { describe, expect, it } from "vitest";

import { parseClientConfig } from "./client";
import { parseServerConfig } from "./server";

const validServerEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://topnow:topnow@127.0.0.1:5432/topnow?schema=public",
  APP_URL: "http://127.0.0.1:3000",
  // Deliberately low-entropy and self-describing: a random-looking hex string
  // here reads as a real leaked secret to a scanner, and did.
  CRON_SECRET: "cron-secret-placeholder-for-tests-not-a-real-value",
  STRIPE_SECRET_KEY: "sk_test_placeholder_not_a_real_key",
  STRIPE_WEBHOOK_SECRET: "whsec_placeholder_not_a_real_secret",
} satisfies Record<string, string | undefined>;

describe("server config", () => {
  it("accepts a complete environment", () => {
    expect(parseServerConfig(validServerEnv)).toMatchObject({
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1:3000",
    });
  });

  it("defaults NODE_ENV to development", () => {
    const { NODE_ENV, ...withoutNodeEnv } = validServerEnv;
    void NODE_ENV;
    expect(parseServerConfig(withoutNodeEnv).NODE_ENV).toBe("development");
  });

  // The point of validating at boot is that the error names the variable, so
  // that a misconfigured deploy is diagnosable without reading a stack trace.
  it("names the missing variable", () => {
    const { DATABASE_URL, ...withoutUrl } = validServerEnv;
    void DATABASE_URL;
    expect(() => parseServerConfig(withoutUrl)).toThrowError(/DATABASE_URL/);
  });

  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() =>
      parseServerConfig({ ...validServerEnv, DATABASE_URL: "mysql://localhost/topnow" }),
    ).toThrowError(/postgres/);
  });

  // #22 authenticates the hourly job with this; a short one is guessable.
  it("rejects a CRON_SECRET that is too short to be worth having", () => {
    expect(() => parseServerConfig({ ...validServerEnv, CRON_SECRET: "short" })).toThrowError(
      /CRON_SECRET/,
    );
  });

  // Placeholders let the app boot without credentials; stripeConfigured() is
  // what stops a placeholder ever being sent to Stripe.
  it("accepts Stripe placeholders so the app boots without credentials", () => {
    expect(parseServerConfig(validServerEnv).STRIPE_SECRET_KEY).toContain("placeholder");
  });

  it("still requires the Stripe variables to be present", () => {
    const { STRIPE_SECRET_KEY, ...without } = validServerEnv;
    void STRIPE_SECRET_KEY;
    expect(() => parseServerConfig(without)).toThrowError(/STRIPE_SECRET_KEY/);
  });

  it("rejects a relative APP_URL", () => {
    expect(() => parseServerConfig({ ...validServerEnv, APP_URL: "/topnow" })).toThrowError(
      /APP_URL/,
    );
  });

  it("reports every problem at once rather than one per restart", () => {
    const message = (() => {
      try {
        parseServerConfig({ NODE_ENV: "test" });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();

    expect(message).toMatch(/DATABASE_URL/);
    expect(message).toMatch(/APP_URL/);
  });
});

describe("client config", () => {
  // Decision D3: the market panel is hidden until a slot has 20h of sampled ask.
  // Defaulting to off means forgetting the variable cannot reveal the panel early.
  it("defaults the market panel to off", () => {
    expect(parseClientConfig({}).NEXT_PUBLIC_MARKET_PANEL_ENABLED).toBe(false);
  });

  it("parses the flag into a boolean", () => {
    expect(
      parseClientConfig({ NEXT_PUBLIC_MARKET_PANEL_ENABLED: "true" })
        .NEXT_PUBLIC_MARKET_PANEL_ENABLED,
    ).toBe(true);
  });

  it("rejects a value that is neither true nor false", () => {
    expect(() => parseClientConfig({ NEXT_PUBLIC_MARKET_PANEL_ENABLED: "yes" })).toThrowError(
      /NEXT_PUBLIC_MARKET_PANEL_ENABLED/,
    );
  });
});

describe("the admin surface's configuration (#17)", () => {
  const REAL_HASH =
    "scrypt:16384:8:1:mIjb3dr-GGv6yE55CAa-zw:IqL1mEbSLLRWX9dsD3z5J6gNO7cwYv31mEqqfCGzpUo";

  it("leaves the surface off when nothing is set", () => {
    const config = parseServerConfig(validServerEnv);
    expect(config.ADMIN_PASSWORD_HASH).toBe("");
    expect(config.ADMIN_SESSION_SECRET).toBe("");
  });

  it("accepts a real hash", () => {
    const config = parseServerConfig({ ...validServerEnv, ADMIN_PASSWORD_HASH: REAL_HASH });
    expect(config.ADMIN_PASSWORD_HASH).toBe(REAL_HASH);
  });

  it.each([
    ["a bare password", "hunter2hunter2"],
    ["the conventional $-separated form a dotenv loader mangles", "scrypt$16384$8$1$c2FsdA$aGFzaA"],
    ["a truncated hash", "scrypt:16384:8:1:mIjb3dr-GGv6yE55CAa-zw"],
    ["a cost nobody should accept", "scrypt:2:8:1:c2FsdGluZ3NhbHQ:aGFzaA"],
  ])("refuses %s at boot", (_label, hash) => {
    // Not merely tidiness. A hash this app cannot parse still reads as
    // "configured", so the sign-in page renders, `verifyPassword` throws on
    // every attempt, `signIn` catches it and returns the same message a wrong
    // password gets — and the operator is locked out of their own admin panel
    // permanently, with nothing in the logs saying why. Failing at boot turns a
    // silent permanent lockout into a named startup error.
    expect(() => parseServerConfig({ ...validServerEnv, ADMIN_PASSWORD_HASH: hash })).toThrow(
      /ADMIN_PASSWORD_HASH/,
    );
  });

  it("allows a deployment to declare that no proxy sits in front of it", () => {
    // Previously `.min(1)`, so this was unrepresentable — and a deployment with
    // nothing in front of it therefore had no address for any caller, dropped
    // everyone into one shared bucket, and refused the sixth checkout
    // site-wide.
    expect(
      parseServerConfig({ ...validServerEnv, RATE_LIMIT_TRUSTED_PROXIES: "0" })
        .RATE_LIMIT_TRUSTED_PROXIES,
    ).toBe(0);
  });
});
