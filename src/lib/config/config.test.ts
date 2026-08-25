import { describe, expect, it } from "vitest";

import { parseClientConfig } from "./client";
import { parseServerConfig } from "./server";

const validServerEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://topnow:topnow@127.0.0.1:5432/topnow?schema=public",
  APP_URL: "http://127.0.0.1:3000",
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
