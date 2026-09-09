/**
 * The visual fidelity capture (`npm run fidelity`) — #5.
 *
 * Renders `TopNow.html` and the built app side by side at 360, 768 and 1280 and
 * writes the pairs into `reference/fidelity/`, so a reviewer can see them
 * without running anything.
 *
 * ## Why a script rather than a session with a screenshot key
 *
 * The issue asks for this to be repeatable, and the reason is that a fidelity
 * pass done by hand is a fidelity pass done once. Every later change to spacing
 * or type can be re-checked by running this again and diffing, which is the
 * difference between a gate and an anecdote.
 *
 * ## It seeds, and therefore it truncates
 *
 * A comparison of an empty board against a prototype full of fabricated
 * listings compares nothing. So the script seeds a fixed board through the real
 * pricing engine — the same thing the e2e suite does — captures that, then
 * clears it and captures the genuine empty state, which the issue asks for
 * separately.
 *
 * **It truncates the database it runs against**, exactly like `npm run
 * scenarios`. Point it at a scratch one.
 *
 * The seeded rows are a fixture for a screenshot. They are not, and must never
 * become, a way of making the product look busier than it is: nothing in the app
 * reads them, and they are deleted before the run ends.
 *
 * ## Finding a panel on both sides
 *
 * The prototype is a bundled export — generic divs, inline styles, no classes or
 * ids to hold on to. So panels are located the way a person would, by the text
 * in the title bar, and then resolved to the plate containing it by climbing to
 * the nearest ancestor whose computed box-shadow is the raised bevel
 * (`inset -2px -2px 0 …`). A plate *is* that shadow, in both codebases, which
 * makes it the one structural fact the two share.
 *
 * ## The difference that is not a failure
 *
 * The prototype's board, ledger and chart are fabricated (`buildMarket`, `LIVE`,
 * `QUEUED` in `reference/prototype-logic.js`). The app shows real state. Compare
 * chrome, type, spacing, bevels and colour usage — not how much content there
 * is. See `reference/fidelity/DEVIATIONS.md`.
 */
import Module from "node:module";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Same shim as scripts/scenarios.ts: the config module is "server-only", whose
// default export throws so that importing it from a client component is a build
// error. This is a Node process, not a React tree.
const resolveFilename = (Module as unknown as { _resolveFilename: (...a: unknown[]) => string })
  ._resolveFilename;
(Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (
  this: unknown,
  request: unknown,
  ...rest: unknown[]
) {
  if (request === "server-only") {
    return join(process.cwd(), "node_modules", "server-only", "empty.js");
  }
  return resolveFilename.call(this, request, ...rest);
};

import { chromium, type Page } from "@playwright/test";
import { config as loadEnv } from "dotenv";

// Same precedence Next.js uses. A plain Node process loads no .env on its own.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const root = resolve(process.cwd());
const outDir = join(root, "reference", "fidelity");
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:3000";

const WIDTHS = [360, 768, 1280] as const;
const HOUR = 3_600_000;

/** The preinstalled Chromium in this container; Playwright's own elsewhere. */
const PREINSTALLED = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const launchOptions = existsSync(PREINSTALLED) ? { executablePath: PREINSTALLED } : {};

/**
 * Panels to crop, by the text that labels them, in the order they appear.
 *
 * Two strategies, because the two codebases put a label in two different places:
 *
 *   band   The label is a heading sitting on the desktop above the panel, and
 *          the prototype's document is flat — heading and panels are siblings in
 *          one container, so no ancestor isolates a section. A band from this
 *          label down to the next one slices both sides the same way, which is
 *          the point: a crop that means something different on each side is not
 *          a comparison.
 *   plate  The label is a title bar *inside* a bevelled plate, so the plate
 *          itself is the panel and can be found by climbing.
 */
const PANELS = [
  { key: "board", label: "THE BOARD", page: "/", how: "band" },
  { key: "ledger", label: "THE LEDGER", page: "/", how: "band" },
  { key: "market", label: "THE MARKET", page: "/", how: "band" },
  { key: "meter", label: "THE METER", page: "/checkout", how: "band" },
  { key: "receipt", label: "TOPNOW RECEIPT", page: "/checkout", how: "plate" },
] as const;

/** Every band label, so a band knows where the next panel starts. */
const BAND_LABELS = PANELS.filter((panel) => panel.how === "band").map((panel) => panel.label);

/**
 * Resolves a title-bar label to the bevelled plate that contains it.
 *
 * Returns null when the panel is not on the page, which is a real outcome rather
 * than an error: the market panel is behind a flag (D3) and the receipt only
 * exists once a listing has been priced.
 */
async function panelBox(page: Page, label: string, how: "band" | "plate", stops: string[]) {
  return page.evaluate(
    ({ wanted, how, stops }) => {
      // The raised bevel, as the browser reports it. Note the shape: a computed
      // `box-shadow` is `<color> <offsets> inset`, with the keyword last — the
      // authored `inset -2px -2px 0 …` never appears in that order, and a regex
      // anchored the way the CSS is written matches nothing at all.
      const RAISED = /-2px -2px 0px 0px inset/;

      // Written without named helpers on purpose: tsx compiles this file with
      // esbuild's `keepNames`, which rewrites a named function expression to
      // call `__name` — a helper that exists in the Node bundle, not the page.
      //
      // Matching is on an element's *own* text rather than `textContent`,
      // because a title bar carries a right-aligned meta slot as a sibling
      // ("THE BOARD" next to "UPDATES EVERY SECOND"), so requiring a childless
      // element with the exact text finds none of them.
      const found: Record<string, Element> = {};
      for (const element of document.querySelectorAll("body *")) {
        if (element.closest("script, footer")) continue;
        let own = "";
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) own += child.textContent ?? "";
        }
        own = own.trim().toUpperCase();
        if ((own === wanted || stops.includes(own)) && !found[own]) found[own] = element;
      }

      const holder = found[wanted];
      if (!holder) return null;

      const top = holder.getBoundingClientRect().top + window.scrollY;

      if (how === "plate") {
        let node: Element | null = holder;
        while (node && node !== document.body) {
          if (RAISED.test(getComputedStyle(node).boxShadow)) {
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
      }

      // A band runs from this label to whichever labelled panel starts next.
      let bottom = document.documentElement.scrollHeight;
      for (const other of stops) {
        const element = found[other];
        if (!element || other === wanted) continue;
        const otherTop = element.getBoundingClientRect().top + window.scrollY;
        if (otherTop > top + 1 && otherTop < bottom) bottom = otherTop;
      }

      const PAD = 6;
      return {
        x: 0,
        y: Math.max(0, top - PAD),
        width: document.documentElement.clientWidth,
        height: Math.max(1, bottom - top + PAD),
      };
    },
    { wanted: label, how, stops },
  );
}

/** Settles the 1Hz clocks and any font swap before a capture. */
async function settle(page: Page) {
  // Park the pointer off-screen first: the script clicks CONTINUE to reach the
  // receipt, and leaving the cursor there captured that button in its hover
  // state — a difference from the prototype that was entirely the capture's own
  // doing.
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

/**
 * @param only  Which page's panels to look for. The prototype is a single
 *              document carrying every panel, so it passes "all".
 */
async function capture(
  page: Page,
  prefix: string,
  width: number,
  only: "/" | "/checkout" | "all" = "/",
) {
  await settle(page);

  const full = join(outDir, `${prefix}-${width}.png`);
  await page.screenshot({ path: full, fullPage: true });
  console.log(`  ${full.slice(root.length + 1)}`);

  for (const panel of PANELS.filter((entry) => only === "all" || entry.page === only)) {
    const box = await panelBox(page, panel.label, panel.how, [...BAND_LABELS]);
    if (!box) {
      console.log(`  — ${panel.key} not on this page at ${width} (${prefix})`);
      continue;
    }
    await page.screenshot({
      path: join(outDir, `${prefix}-${panel.key}-${width}.png`),
      clip: box,
      fullPage: true,
    });
    console.log(`  ${`${prefix}-${panel.key}-${width}.png`}`);
  }
}

/**
 * Drives the checkout form far enough to produce a receipt.
 *
 * The receipt does not exist until a listing has been priced, and a capture of a
 * panel that is not on screen is a capture of nothing.
 */
async function priceAListing(page: Page) {
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

/**
 * A board with something on it, built through the real pricing engine.
 *
 * Every figure these rows carry — the ask, the multiplier, the total — is what
 * `quoteForQueue` returns for that slot at that queue depth. Nothing is typed
 * in, because a screenshot with a made-up price in it is exactly the artefact
 * the build prompt forbids, even when it is only a screenshot.
 */
async function seed() {
  const { getDb } = await import("../src/lib/db");
  const { quoteForQueue, baseHrCents, askHrCents, surgeFromQueuedHours } =
    await import("../src/lib/pricing");

  const db = getDb();
  await clear();

  const now = Date.now();

  async function purchase(overrides: Record<string, unknown>) {
    const slot = overrides.slot as 1 | 2 | 3;
    const durationH = overrides.durationH as 1 | 3 | 6 | 12 | 24;
    const queuedHours = (overrides.queuedHours as number) ?? 0;
    const quote = quoteForQueue(slot, durationH, queuedHours);
    delete overrides.queuedHours;

    return db.purchase.create({
      data: {
        platform: "github",
        tagline: "Open-source invoicing for freelancers who hate invoicing.",
        priceHrCents: quote.askHrCents,
        totalPaidCents: quote.totalCents,
        ...overrides,
      } as never,
    });
  }

  // Slot 01: live, with a queue behind it so the surge and the wait are real.
  await purchase({
    slot: 1,
    durationH: 6,
    handle: "mira-builds",
    targetUrl: "https://github.com/mira-builds",
    status: "live",
    boughtAt: new Date(now - 2 * HOUR),
    startsAt: new Date(now - 2 * HOUR),
    endsAt: new Date(now + 4 * HOUR),
  });
  await purchase({
    slot: 1,
    durationH: 3,
    handle: "parcelkit",
    targetUrl: "https://github.com/parcelkit",
    tagline: "A small tool that does one thing and stops.",
    boughtAt: new Date(now - HOUR),
    queuedHours: 0,
  });
  await purchase({
    slot: 1,
    durationH: 1,
    handle: "quietstack",
    targetUrl: "https://github.com/quietstack",
    tagline: "Static hosting with no dashboard.",
    boughtAt: new Date(now - 30 * 60_000),
    queuedHours: 3,
  });

  // Slot 02: live, no queue. Slot 03: left open, because the vacant plate is a
  // designed state and belongs in the comparison.
  await purchase({
    slot: 2,
    durationH: 3,
    handle: "halfbuilt",
    targetUrl: "https://github.com/halfbuilt",
    tagline: "Half-finished things, shipped anyway.",
    status: "live",
    boughtAt: new Date(now - 40 * 60_000),
    startsAt: new Date(now - 40 * 60_000),
    endsAt: new Date(now + 2 * HOUR + 20 * 60_000),
  });

  // The tape needs something ended.
  for (const [index, handle] of ["oldmap", "tinyfeed", "slowbuild"].entries()) {
    const startsAt = new Date(now - (12 + index * 3) * HOUR);
    await purchase({
      slot: ((index % 3) + 1) as 1 | 2 | 3,
      durationH: 3,
      handle,
      targetUrl: `https://github.com/${handle}`,
      tagline: "Ran its hours and came off the board.",
      status: "ended",
      boughtAt: new Date(startsAt.getTime() - 60_000),
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * HOUR),
    });
  }

  // Twenty-four hours of hourly samples per slot, so the chart has candles and
  // D3's twenty-hour threshold is genuinely met rather than bypassed.
  const anchor = Math.floor(now / HOUR) * HOUR;
  for (const slot of [1, 2, 3] as const) {
    await db.askSample.createMany({
      data: Array.from({ length: 24 }, (_, i) => {
        // A queue that builds through the day and drains, so the line moves for
        // the reason the product says it moves: queued hours (D2).
        const queuedHours = Math.max(0, Math.round(9 - Math.abs(12 - i) * 0.9));
        const multiplierCm = surgeFromQueuedHours(queuedHours);
        return {
          slot,
          hour: new Date(anchor - (24 - i) * HOUR),
          askHrCents: askHrCents(slot, multiplierCm),
          baseHrCents: baseHrCents(slot),
          queuedHours,
        };
      }),
    });
  }

  // A handful of visitors, so the counters read something other than one.
  await db.visit.createMany({
    data: Array.from({ length: 7 }, (_, i) => ({
      visitorHash: String(i + 1).padStart(64, "0"),
      bucket: new Date(Math.floor(now / 1_800_000) * 1_800_000),
      firstSeenAt: new Date(now - 60_000),
      lastSeenAt: new Date(now - 30_000),
    })),
  });
}

async function clear() {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  await db.adminAction.deleteMany();
  await db.report.deleteMany();
  await db.rateLimit.deleteMany();
  await db.visit.deleteMany();
  await db.askSample.deleteMany();
  await db.embed.deleteMany();
  await db.avatar.deleteMany();
  await db.purchase.deleteMany();
}

async function main() {
  console.log("This truncates DATABASE_URL. Point it at a scratch database.\n");

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
      await capture(page, "prototype", width, "all");

      await seed();
      await page.goto(`${appUrl}/`, { waitUntil: "networkidle" });
      await capture(page, "app", width);

      await page.goto(`${appUrl}/checkout`, { waitUntil: "networkidle" });
      await priceAListing(page);
      await capture(page, "app-checkout", width, "/checkout");

      // The genuine empty state, which the issue asks for by name: on launch day
      // this is the whole product, and it has no prototype counterpart.
      await clear();
      // Past the counters' process cache, so the empty capture shows real zeros
      // rather than the seeded numbers held over from the render before it. A
      // screenshot of an empty board with seven visitors on it is exactly the
      // kind of number this product is not allowed to print.
      const { COUNTS_CACHE_MS } = await import("../src/lib/visits/constants");
      await page.waitForTimeout(COUNTS_CACHE_MS + 1_000);
      await page.goto(`${appUrl}/`, { waitUntil: "networkidle" });
      await capture(page, "app-empty", width);

      await context.close();
    }
  } finally {
    await browser.close();
    await clear();
    const { getDb } = await import("../src/lib/db");
    await getDb().$disconnect();
  }

  console.log(`\nWritten to ${outDir.slice(root.length + 1)}`);
}

// `main()` rather than a top-level await: tsx transpiles this to CommonJS —
// the `_resolveFilename` shim above depends on that — and CommonJS has no
// top-level await.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
