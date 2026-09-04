import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Playwright runs outside the Next.js runtime, so it does not load .env files on
// its own. board.spec.ts talks to Postgres directly and needs DATABASE_URL.
// CI supplies these as real environment variables; locally they come from here.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

/**
 * Chromium is preinstalled in the dev container under PLAYWRIGHT_BROWSERS_PATH.
 * Never run `playwright install` — see README.
 *
 * The preinstalled build will not always match the revision this @playwright/test
 * version expects, so point at the binary directly when it is there and fall back
 * to Playwright's own resolution everywhere else (CI, a contributor's laptop).
 */
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const launch = existsSync(PREINSTALLED_CHROMIUM) ? { executablePath: PREINSTALLED_CHROMIUM } : {};
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.APP_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
    launchOptions: launch,
  },
  projects: [
    /**
     * The three widths the visual fidelity pass (#5) is held against.
     *
     * They ignore the specs that seed a database every worker shares. Running
     * those once per viewport would have three projects clearing and seeding
     * concurrently, and skipping the tests is not enough — beforeAll hooks still
     * run — so the exclusion has to be at project level.
     */
    {
      name: "mobile-360",
      testIgnore: /(board|receipt|ledger|market|pricing|avatar|embed|counters|ticker)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 } },
    },
    {
      name: "tablet-768",
      testIgnore: /(board|receipt|ledger|market|pricing|avatar|embed|counters|ticker)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1280",
      testIgnore: /(board|receipt|ledger|market|pricing|avatar|embed|counters|ticker)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    /**
     * Stateful suites, each run once.
     *
     * `mode: "serial"` only orders tests within a file — two stateful files
     * still land in different workers and clobber each other's rows. A project
     * dependency is what actually serialises them: `receipt` does not start
     * until `board` has finished.
     */
    {
      name: "board",
      testMatch: /board\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "receipt",
      testMatch: /receipt\.spec\.ts/,
      dependencies: ["board"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "ledger",
      testMatch: /ledger\.spec\.ts/,
      dependencies: ["receipt"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "market",
      testMatch: /market\.spec\.ts/,
      dependencies: ["ledger"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "pricing",
      testMatch: /pricing\.spec\.ts/,
      dependencies: ["market"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "avatar",
      testMatch: /avatar\.spec\.ts/,
      dependencies: ["pricing"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "embed",
      testMatch: /embed\.spec\.ts/,
      dependencies: ["avatar"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "counters",
      testMatch: /counters\.spec\.ts/,
      dependencies: ["embed"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "ticker",
      testMatch: /ticker\.spec\.ts/,
      dependencies: ["counters"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
