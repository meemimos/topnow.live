#!/usr/bin/env node
/**
 * The visual fidelity capture (#5).
 *
 *     npm run build && npm start &
 *     node scripts/fidelity.mjs
 *
 * Renders `TopNow.html` and the built app side by side at 360, 768 and 1280, and
 * writes the pairs into reference/fidelity/ so a reviewer can see them without
 * running anything.
 *
 * ## Why a script rather than a session with a screenshot key
 *
 * The issue asks for this to be repeatable, and the reason is that a fidelity
 * pass done by hand is a fidelity pass done once. Every later change to spacing
 * or type can be re-checked by running this again and looking at the diff, which
 * is the difference between a gate and an anecdote.
 *
 * ## Finding a panel on both sides
 *
 * The prototype is a bundled export: generic divs, inline styles, no classes or
 * ids to hold on to. So panels are located the way a person would — by the text
 * in the title bar — and then resolved to the plate that contains it, by
 * climbing to the nearest ancestor whose computed box-shadow is the raised bevel
 * (`inset -2px -2px 0 …`). A plate *is* that shadow, in both codebases, which
 * makes it the one structural fact the two share.
 *
 * ## The one difference that is not a failure
 *
 * The prototype's board, ledger and chart are fabricated (`buildMarket`, `LIVE`,
 * `QUEUED` in reference/prototype-logic.js). The app shows real state, which on
 * a fresh database is emptier. That is correct and is not a fidelity failure —
 * see reference/fidelity/DEVIATIONS.md. Compare chrome, type, spacing, bevels
 * and colour usage, not how much content there is.
 */
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "reference", "fidelity");
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:3000";

const WIDTHS = [360, 768, 1280];

/** The preinstalled Chromium in this container; Playwright's own elsewhere. */
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const launchOptions = existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {};

/**
 * Panels to crop, by the text in their title bar.
 *
 * `page` says which of the app's pages carries it; the prototype is one document
 * and carries all of them.
 */
const PANELS = [
  { key: "board", label: "THE BOARD", page: "/" },
  { key: "ledger", label: "THE LEDGER", page: "/" },
  { key: "market", label: "THE MARKET", page: "/" },
  { key: "meter", label: "THE METER", page: "/checkout" },
  { key: "receipt", label: "TOPNOW RECEIPT", page: "/checkout" },
];

/**
 * Resolves a title-bar label to the bevelled plate that contains it.
 *
 * Runs in the page so it can read computed styles. Returns a bounding box, or
 * null when the panel is not on this page — which is a real outcome, not an
 * error: the market panel is behind a flag (D3) and the receipt only exists once
 * a listing has been priced.
 */
async function panelBox(page, label) {
  return page.evaluate((wanted) => {
    const RAISED = /^inset -2px -2px 0/;

    const holder = [...document.querySelectorAll("*")].find(
      (element) =>
        element.children.length === 0 && element.textContent?.trim().toUpperCase() === wanted,
    );
    if (!holder) return null;

    let node = holder;
    while (node && node !== document.body) {
      const shadow = getComputedStyle(node).boxShadow;
      if (RAISED.test(shadow)) {
        const box = node.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          return {
            x: box.x + window.scrollX,
            y: box.y + window.scrollY,
            width: box.width,
            height: box.height,
          };
        }
      }
      node = node.parentElement;
    }
    return null;
  }, label);
}

/** Settles the 1Hz clocks and any font swap before a capture. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function capture(page, side, width, { pageName = "/" } = {}) {
  await settle(page);

  const full = join(outDir, `${side}-${pageName === "/" ? "board" : "checkout"}-${width}.png`);
  await page.screenshot({ path: full, fullPage: true });
  console.log(`  ${full.slice(root.length + 1)}`);

  for (const panel of PANELS.filter((entry) => entry.page === pageName)) {
    const box = await panelBox(page, panel.label);
    if (!box) {
      console.log(`  — ${panel.key} absent at ${width} (${side})`);
      continue;
    }
    const path = join(outDir, `${side}-${panel.key}-${width}.png`);
    await page.screenshot({ path, clip: box, fullPage: true });
    console.log(`  ${path.slice(root.length + 1)}`);
  }
}

/**
 * Drives the checkout form far enough to produce a receipt.
 *
 * The receipt does not exist until a listing has been priced, and a fidelity
 * capture of a panel that is not on screen is a capture of nothing.
 */
async function priceAListing(page) {
  try {
    await page.fill('input[aria-describedby="derived-url"]', "mira-builds", { timeout: 5_000 });
    await page
      .getByText("One line of copy")
      .locator("..")
      .locator("input")
      .fill("Open-source invoicing for freelancers who hate invoicing.");
    await page.getByRole("button", { name: "CONTINUE" }).click();
    await page.getByText("TOPNOW RECEIPT").waitFor({ timeout: 5_000 });
  } catch {
    console.log("  — receipt not reachable; capturing the form as it stands");
  }
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch(launchOptions);
  const prototypeUrl = pathToFileURL(join(root, "TopNow.html")).href;

  try {
    for (const width of WIDTHS) {
      console.log(`\n${width}px`);
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        // Deterministic captures: the marquee and the meter animate, and a
        // screenshot of a moving thing differs from itself run to run.
        reducedMotion: "reduce",
      });
      const page = await context.newPage();

      await page.goto(prototypeUrl, { waitUntil: "networkidle" });
      await capture(page, "prototype", width);

      await page.goto(`${appUrl}/`, { waitUntil: "networkidle" });
      await capture(page, "app", width);

      await page.goto(`${appUrl}/checkout`, { waitUntil: "networkidle" });
      await priceAListing(page);
      await capture(page, "app", width, { pageName: "/checkout" });

      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\nWritten to ${outDir.slice(root.length + 1)}`);
}

await main();
