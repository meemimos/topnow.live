import { existsSync } from "node:fs";

import { defineConfig, devices } from "@playwright/test";

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
    // The three widths the visual fidelity pass (#5) is held against.
    {
      name: "mobile-360",
      use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 } },
    },
    {
      name: "tablet-768",
      use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } },
    },
    {
      name: "desktop-1280",
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
