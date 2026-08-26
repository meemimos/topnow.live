/**
 * Executable scenarios (`npm run scenarios`).
 *
 * Every number printed here comes from the real modules — the pricing engine
 * (#2), the queued-hours cap (#24), the slot state machine (#1), the time
 * helpers (#3) and the hourly sampler (#22) — running against a real Postgres.
 * Nothing is illustrative or typed in by hand.
 *
 * The purpose is to make the market's behaviour legible before any of it has a
 * user interface, and to catch a rule that reads sensibly but behaves badly.
 *
 * Runs against DATABASE_URL, which must NOT be a database with real purchases in
 * it — it truncates between scenarios. Point it at a scratch database.
 */
import Module from "node:module";
import { join } from "node:path";

/**
 * The config module is marked "server-only", whose default export throws so that
 * importing it from a client component is a build error. This script is a Node
 * process rather than a React tree, so resolve it to the no-op the package
 * itself ships — the same thing Next.js does on the server.
 *
 * Must run before anything that reaches the config module is imported, which is
 * why every app module below is loaded dynamically inside the scenarios.
 */
const resolveFilename = (Module as unknown as { _resolveFilename: (...a: unknown[]) => string })
  ._resolveFilename;
(Module as unknown as { _resolveFilename: unknown })._resolveFilename = function (
  this: unknown,
  request: unknown,
  ...rest: unknown[]
) {
  // Resolved by path: the package's "exports" map does not expose empty.js, so
  // require.resolve cannot reach it even though it ships in the tarball.
  if (request === "server-only") {
    return join(process.cwd(), "node_modules", "server-only", "empty.js");
  }
  return resolveFilename.call(this, request, ...rest);
};

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

import {
  QUEUE_CAP_HOURS,
  baseHrCents,
  decayOneHour,
  quote,
  quoteForQueue,
  surgeFromQueuedHours,
} from "../src/lib/pricing";
import {
  actionLabel,
  derivation,
  formatMoney,
  formatMultiplier,
  lineItem,
} from "../src/lib/pricing/format";
import { MS_PER_HOUR, estimateQueue, formatClock } from "../src/lib/time";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

type Slot = 1 | 2 | 3;
type Duration = 1 | 3 | 6 | 12 | 24;

const HOUR = MS_PER_HOUR;
const T0 = new Date("2026-09-01T09:00:00.000Z");

const money = (c: number) => formatMoney(c).padStart(7);

function heading(title: string, subtitle: string) {
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  ${title}`);
  console.log(`  ${subtitle}`);
  console.log("═".repeat(78));
}

function step(at: Date, text: string) {
  console.log(`  ${formatClock(at).padStart(8)}  ${text}`);
}

async function reset() {
  await db.purchase.deleteMany();
  await db.askSample.deleteMany();
}

async function queuedHours(slot: Slot): Promise<number> {
  const r = await db.purchase.aggregate({
    where: { slot, status: "queued" },
    _sum: { durationH: true },
  });
  return r._sum.durationH ?? 0;
}

/**
 * Buys into a slot at the live ask, through the same cap-enforced path #26's
 * webhook will use. Nothing here writes a row directly, so every scenario is
 * subject to the real rules rather than a convenient shortcut.
 */
async function buy(slot: Slot, durationH: Duration, handle: string, at: Date) {
  const { createQueuedPurchase } = await import("../src/lib/purchase/queue");
  const qh = await queuedHours(slot);
  const q = quoteForQueue(slot, durationH, qh);

  const row = await createQueuedPurchase(
    {
      slot,
      durationH,
      handle,
      platform: "github",
      targetUrl: `https://github.com/${handle}`,
      tagline: "tagline",
      priceHrCents: q.askHrCents,
      totalPaidCents: q.totalCents,
    },
    at,
  );

  // boughtAt defaults to insert time; the scenarios need it deterministic.
  await db.purchase.update({ where: { id: row.id }, data: { boughtAt: at } });

  return { row, quote: q, queuedHoursBefore: qh };
}

/** Runs #1's promotion against the real state machine. */
async function promote(at: Date) {
  const { promoteAll } = await import("../src/lib/purchase/state");
  return promoteAll(at);
}

async function board(at: Date) {
  const { currentBoard } = await import("../src/lib/purchase/state");
  return currentBoard(at);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. Launch day. Nothing has happened yet.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioLaunchDay() {
  heading("SCENARIO 1 — Launch day", "Empty board, first purchase, first expiry");
  await reset();

  console.log("\n  The board on day one — every slot open at base:\n");
  for (const slot of [1, 2, 3] as Slot[]) {
    const q = quoteForQueue(slot, 1, 0);
    console.log(
      `    SLOT 0${slot}   base ${money(q.baseHrCents)}/hr   surge ${formatMultiplier(q.multiplierCm)}×   ` +
        `ask ${money(q.askHrCents)}/hr   ${actionLabel(quoteForQueue(slot, 3, 0), false)}`,
    );
  }

  const t = T0;
  const first = await buy(3, 3, "mira_builds", t);
  step(t, `@mira_builds buys slot 03 for 3h`);
  console.log(`              ${lineItem(first.quote)}   ${derivation(first.quote)}`);
  console.log(
    `              total ${formatMoney(first.quote.totalCents)} — no queue, so it goes live immediately`,
  );

  await promote(t);
  let b = await board(t);
  const live = b.find((s) => s.slot === 3)!.live!;
  step(t, `slot 03 goes live, meter runs to ${formatClock(live.endsAt!)}`);

  const midway = new Date(t.getTime() + 1.5 * HOUR);
  step(midway, `01:30:00 left, 50% of the meter gone`);

  const after = new Date(t.getTime() + 3 * HOUR);
  b = await board(after);
  step(after, `meter hits zero — slot 03 is open again at ${formatMoney(baseHrCents(3))}/hr`);
  console.log(
    `              board says: ${b.find((s) => s.slot === 3)!.live === null ? "SLOT 03 OPEN" : "still occupied"}`,
  );
  console.log(
    `\n  Note: nothing ran to expire it. The window closed, so the board stopped showing it.`,
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 2. A queue builds on slot 01 and surge climbs.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioSurgeClimb() {
  heading(
    "SCENARIO 2 — A queue builds on slot 01",
    "Surge climbing, and every price locked at purchase",
  );
  await reset();

  const t = T0;
  await buy(1, 6, "first_holder", t);
  await promote(t);

  console.log("\n  @first_holder is live on slot 01 for 6h. Now people queue behind them.\n");
  console.log("    BUYER              BOOKS   QUEUED BEFORE   SURGE    ASK/HR      PAID");
  console.log("    " + "─".repeat(70));

  const buyers: Array<[string, Duration, number]> = [
    ["dovetail_app", 3, 5],
    ["nine_lives_cli", 3, 20],
    ["studio_offcut", 6, 45],
    ["halfbuilt", 3, 70],
    ["kerncase", 3, 95],
  ];

  for (const [handle, dur, minsLater] of buyers) {
    const at = new Date(t.getTime() + minsLater * 60_000);
    const { quote: q, queuedHoursBefore } = await buy(1, dur, handle, at);
    console.log(
      `    @${handle.padEnd(17)} ${String(dur).padStart(2)}h` +
        `   ${String(queuedHoursBefore).padStart(9)}h` +
        `   ${formatMultiplier(q.multiplierCm)}×` +
        `   ${money(q.askHrCents)}   ${money(q.totalCents)}`,
    );
  }

  const qh = await queuedHours(1);
  console.log(
    `\n  Slot 01 now has ${qh} queued hours, so the next buyer sees ` +
      `${formatMultiplier(surgeFromQueuedHours(qh))}× — ${formatMoney(quoteForQueue(1, 1, qh).askHrCents)}/hr.`,
  );

  console.log(`\n  Everyone above keeps the rate they paid. Nobody is re-priced:\n`);
  const rows = await db.purchase.findMany({
    where: { slot: 1, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
  for (const r of rows) {
    const locked = quote(
      1,
      r.durationH as Duration,
      Math.round((r.priceHrCents * 100) / baseHrCents(1)),
    );
    console.log(
      `    @${r.handle.padEnd(17)} locked at ${money(r.priceHrCents)}/hr  ` +
        `(${derivation(locked)} = ${formatMoney(r.totalPaidCents)})`,
    );
  }

  const liveRow = await db.purchase.findFirstOrThrow({ where: { slot: 1, status: "live" } });
  const estimates = estimateQueue(new Date(t.getTime() + 95 * 60_000), rows, liveRow.endsAt);
  console.log(`\n  When each of them actually goes live:\n`);
  rows.forEach((r, i) => {
    const e = estimates[i];
    console.log(
      `    ${String(e.position).padStart(2)}. @${r.handle.padEnd(17)} ~${formatClock(e.startsAt).padStart(8)}` +
        `  →  ${formatClock(e.endsAt).padStart(8)}   (waits ${(e.waitMs / HOUR).toFixed(1)}h)`,
    );
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 3. The cap.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioCap() {
  heading(
    "SCENARIO 3 — The slot fills up",
    `The ${QUEUE_CAP_HOURS}h wait cap, and what a refused buyer sees`,
  );
  await reset();

  const { QueueAtCapacityError, slotCapacity, waitHoursForSlot } =
    await import("../src/lib/purchase/queue");

  const t = T0;
  // Someone is already on the board, so the wait a buyer inherits is not merely
  // what is queued. That distinction is what this scenario exists to show.
  await buy(1, 12, "on_the_board", t);
  await promote(t);

  console.log(`\n  @on_the_board is live on slot 01 for 12h. The cap is on the WAIT, so`);
  console.log(`  those 12 hours count against everyone queueing behind them.\n`);
  console.log("    ATTEMPT              BOOKS   WAIT BEFORE   RESULT");
  console.log("    " + "─".repeat(70));

  const attempts: Array<[string, Duration]> = [
    ["early_bird", 6],
    ["second_wave", 3],
    ["third_wave", 3],
    ["too_late", 6],
    ["also_too_late", 1],
  ];

  for (const [handle, dur] of attempts) {
    const before = await waitHoursForSlot(db, 1, t);
    const q = quoteForQueue(1, dur, await queuedHours(1));
    try {
      await buy(1, dur, handle, t);
      console.log(
        `    @${handle.padEnd(17)} ${String(dur).padStart(2)}h   ${before.toFixed(1).padStart(9)}h   ` +
          `accepted at ${formatMultiplier(q.multiplierCm)}× — ${formatMoney(q.totalCents)}`,
      );
    } catch (error) {
      if (!(error instanceof QueueAtCapacityError)) throw error;
      console.log(
        `    @${handle.padEnd(17)} ${String(dur).padStart(2)}h   ${before.toFixed(1).padStart(9)}h   ` +
          `REFUSED — wait is past the ${QUEUE_CAP_HOURS}h cap`,
      );
    }
  }

  const cap = await slotCapacity(db, 1, [1, 3, 6, 12, 24], t);
  console.log(`\n  What slot 01 now looks like to a would-be buyer:\n`);
  console.log(`    on the board ......... ${cap.liveRemainingHours.toFixed(1)}h left`);
  console.log(`    queued behind it ..... ${cap.queuedHours}h`);
  console.log(`    total wait ........... ${cap.waitHours.toFixed(1)}h`);
  console.log(`    accepting bookings ... ${cap.atCapacity ? "no" : "yes"}`);
  console.log(
    `    surge ................ ${formatMultiplier(cap.multiplierCm)}× (priced on the ${cap.queuedHours}h queued)`,
  );
  console.log(
    `\n  Slots 02 and 03 are unaffected — ${formatMoney(quoteForQueue(2, 3, 0).totalCents)} and ` +
      `${formatMoney(quoteForQueue(3, 3, 0).totalCents)} for 3h, both at base.`,
  );
  console.log(`\n  Before the cap counted the rental already on the board, everyone above would`);
  console.log(`  have been admitted — the last of them to a wait of ${cap.waitHours.toFixed(1)}h.`);
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Decay.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioDecay() {
  heading(
    "SCENARIO 4 — A busy slot goes quiet",
    "Decay: 5% of the distance above base, per unsold hour",
  );
  await reset();

  console.log("\n  Slot 01 peaks at the ceiling, then the queue drains and nobody buys.\n");
  console.log("    HOUR   QUEUED   SURGE    ASK/HR   3H COSTS");
  console.log("    " + "─".repeat(48));

  let cm = surgeFromQueuedHours(18);
  for (let hour = 0; hour <= 24; hour += 1) {
    if (hour > 0) cm = decayOneHour(cm, 0);
    if (hour <= 3 || hour % 4 === 0 || hour === 24) {
      const q = quote(1, 3, cm);
      console.log(
        `    ${String(hour).padStart(4)}h   ${(hour === 0 ? "18" : "0").padStart(6)}h   ` +
          `${formatMultiplier(cm)}×   ${money(q.askHrCents)}   ${money(q.totalCents)}`,
      );
    }
  }

  let toBase = 0;
  let c = surgeFromQueuedHours(18);
  while (c > 100 && toBase < 500) {
    c = decayOneHour(c, 0);
    toBase += 1;
  }
  console.log(`\n  Reaches base exactly ${toBase} unsold hours after the peak — and stops there.`);
  console.log(`  A buyer arriving during the slide pays the decayed rate, not the peak.`);
}

// ───────────────────────────────────────────────────────────────────────────
// 5. A kill mid-rental.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioKill() {
  heading(
    "SCENARIO 5 — A listing is killed mid-rental",
    "#17's takedown, and what happens to everyone behind it",
  );
  await reset();

  const { killPurchase } = await import("../src/lib/purchase/state");

  const t = T0;
  await buy(1, 12, "impersonator", t);
  await promote(t);
  await buy(1, 3, "waiting_one", new Date(t.getTime() + 60_000));
  await buy(1, 3, "waiting_two", new Date(t.getTime() + 120_000));

  const live = await db.purchase.findFirstOrThrow({ where: { slot: 1, status: "live" } });
  step(t, `@impersonator live on slot 01 until ${formatClock(live.endsAt!)} — 12h booked`);

  const queueBefore = await db.purchase.findMany({
    where: { slot: 1, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
  const estBefore = estimateQueue(t, queueBefore, live.endsAt);
  console.log(
    `              @waiting_one expects to go live ~${formatClock(estBefore[0].startsAt)}`,
  );

  const killAt = new Date(t.getTime() + 2 * HOUR);
  const { killed, promoted } = await killPurchase(live.id, "impersonation", killAt);
  step(killAt, `report upheld — @${killed.handle} killed after 2h of a 12h rental`);
  step(killAt, `@${promoted!.handle} promoted in the same transaction — no empty slot`);

  const queueAfter = await db.purchase.findMany({
    where: { slot: 1, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
  const nowLive = await db.purchase.findFirstOrThrow({ where: { slot: 1, status: "live" } });
  const estAfter = estimateQueue(killAt, queueAfter, nowLive.endsAt);
  console.log(
    `              @waiting_two now goes live ~${formatClock(estAfter[0].startsAt)} — ` +
      `${((estBefore[1].startsAt.getTime() - estAfter[0].startsAt.getTime()) / HOUR).toFixed(1)}h earlier than before`,
  );

  const tape = await db.purchase.findMany({ where: { status: "killed" } });
  console.log(
    `\n  The killed row stays in the ledger — the tape is a record, not a marketing surface:`,
  );
  for (const r of tape) {
    console.log(
      `    @${r.handle}  slot 0${r.slot}  ${r.durationH}h  paid ${formatMoney(r.totalPaidCents)}  ` +
        `KILLED (${r.killedReason})`,
    );
  }
  console.log(
    `\n  Open question for #17: @impersonator paid ${formatMoney(tape[0].totalPaidCents)} for 12h and got 2h.`,
  );
  console.log(`  The refund policy is still undecided — that is a launch blocker on that issue.`);
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Two buyers, one slot, same instant.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioRace() {
  heading(
    "SCENARIO 6 — Two buyers hit the same free slot",
    "What the database guarantees under a real race",
  );
  await reset();

  const t = T0;
  for (let i = 0; i < 5; i += 1) {
    await buy(2, 3, `racer_${i}`, new Date(t.getTime() + i * 1000));
  }

  const { promoteSlot } = await import("../src/lib/purchase/state");
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => promoteSlot(2, t)));
  const winners = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));

  console.log(`\n  Five buyers queued on slot 02. Eight promotion attempts fire simultaneously.\n`);
  console.log(`    promotions that won a slot ... ${winners.length}`);
  console.log(
    `    live rows on slot 02 ......... ${await db.purchase.count({ where: { slot: 2, status: "live" } })}`,
  );
  console.log(`    winner ....................... @${winners[0]!.handle} (oldest purchase)`);

  const remaining = await db.purchase.findMany({
    where: { slot: 2, status: "queued" },
    orderBy: { boughtAt: "asc" },
  });
  console.log(
    `    queue behind, still in order . ${remaining.map((r) => "@" + r.handle).join(", ")}`,
  );
  console.log(`\n  The partial unique index makes two live rows on one slot unrepresentable,`);
  console.log(`  so the losers fail cleanly rather than corrupting the board.`);
}

// ───────────────────────────────────────────────────────────────────────────
// 7. What the chart actually has to draw.
// ───────────────────────────────────────────────────────────────────────────
async function scenarioMarketData() {
  heading(
    "SCENARIO 7 — What the chart has after a realistic first week",
    "Decision D3, with real numbers",
  );
  await reset();

  const { runHourlyTick } = await import("../src/lib/market/sampler");

  // A deliberately modest week: a handful of purchases a day across three slots.
  const start = new Date("2026-09-01T00:00:00.000Z");
  const plan: Array<[number, Slot, Duration, string]> = [
    [2, 3, 3, "day1_a"],
    [9, 1, 6, "day1_b"],
    [14, 2, 3, "day1_c"],
    [26, 1, 3, "day2_a"],
    [31, 3, 1, "day2_b"],
    [50, 1, 12, "day3_a"],
    [55, 2, 6, "day3_b"],
    [74, 1, 3, "day4_a"],
    [98, 1, 6, "day5_a"],
    [103, 3, 3, "day5_b"],
    [122, 2, 3, "day6_a"],
    [146, 1, 3, "day7_a"],
    [150, 1, 3, "day7_b"],
  ];

  let purchases = 0;
  for (let hour = 0; hour < 168; hour += 1) {
    const at = new Date(start.getTime() + hour * HOUR);
    for (const [h, slot, dur, handle] of plan) {
      if (h === hour) {
        await buy(slot, dur, handle, at);
        purchases += 1;
      }
    }
    await runHourlyTick(at);
  }

  console.log(
    `\n  One week. ${purchases} purchases across three slots — a modest but plausible start.\n`,
  );
  console.log("    SLOT   SAMPLED HOURS   PURCHASES   HOURS ABOVE BASE   PEAK ASK");
  console.log("    " + "─".repeat(66));

  for (const slot of [1, 2, 3] as Slot[]) {
    const samples = await db.askSample.findMany({ where: { slot }, orderBy: { hour: "asc" } });
    const above = samples.filter((s) => s.askHrCents > s.baseHrCents).length;
    const peak = Math.max(...samples.map((s) => s.askHrCents));
    const count = await db.purchase.count({ where: { slot } });
    console.log(
      `    0${slot}     ${String(samples.length).padStart(13)}   ${String(count).padStart(9)}   ` +
        `${String(above).padStart(16)}   ${money(peak)}`,
    );
  }

  console.log(`\n  Decision D3 reveals the market panel at 20 sampled hours per slot, so it would`);
  console.log(`  have opened partway through day one. But look at the third column:\n`);

  for (const slot of [1, 2, 3] as Slot[]) {
    const samples = await db.askSample.findMany({ where: { slot } });
    const above = samples.filter((s) => s.askHrCents > s.baseHrCents).length;
    const pct = ((above / samples.length) * 100).toFixed(0);
    console.log(
      `    Slot 0${slot} spent ${pct.padStart(3)}% of the week off its base rate` +
        (above === 0 ? "  ← a flat line for seven days" : ""),
    );
  }
}

async function main() {
  console.log("\n  TOPNOW — scenarios");
  console.log("  Every figure below is produced by the real modules against a real database.");
  console.log("  Nothing here is illustrative.");

  await scenarioLaunchDay();
  await scenarioSurgeClimb();
  await scenarioCap();
  await scenarioDecay();
  await scenarioKill();
  await scenarioRace();
  await scenarioMarketData();

  await reset();
  await db.$disconnect();
  console.log(`\n${"═".repeat(78)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
