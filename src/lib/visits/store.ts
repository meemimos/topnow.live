import "server-only";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";

import { COUNTS_CACHE_MS, ONLINE_WINDOW_MS, VISIT_WINDOW_MS } from "./constants";
import { bucketFor, clientAddress, looksLikeABot, visitorHash } from "./identity";

/**
 * Recording and reading the counters (#15).
 *
 * Two rules from the issue, and the whole file is arranged around them:
 *
 * **Never a live query per request.** Reads come from a process-local cache with
 * a short TTL, so however many people are looking, at most one counting query
 * crosses the database per interval. A counter that costs a round trip on every
 * page load is a self-inflicted outage on the day the page is popular.
 *
 * **The number floors at the truth.** Nothing here rounds up, nothing has a
 * minimum, and zero is a value the product is willing to print.
 */

/**
 * The salt for the visitor hash.
 *
 * Derived from `CRON_SECRET` rather than added as its own variable: it needs to
 * be server-side, stable within a day and unguessable, and that value already
 * is all three. It is used only as a hash input and never emitted, so a
 * derivation is enough — this is not a second use of a credential, it is a
 * one-way function of one.
 */
function salt(): string {
  return `visit:${serverConfig().CRON_SECRET}`;
}

/**
 * Note that somebody is looking at the board.
 *
 * Called from the page render. Idempotent within the window: the unique index on
 * (hash, bucket) means ten reloads are one row, and the update only moves
 * `lastSeenAt`, which is what "online now" reads.
 *
 * Never throws. A counter is the least important thing on the page, and a
 * database hiccup must not take the board down with it.
 */
export async function recordVisit(
  headers: Headers,
  now: Date = new Date(),
): Promise<"created" | "seen" | "bot" | "failed"> {
  const userAgent = headers.get("user-agent");
  if (looksLikeABot(userAgent)) return "bot";

  const hash = visitorHash({ address: clientAddress(headers), userAgent: userAgent! }, salt(), now);
  const bucket = bucketFor(now, VISIT_WINDOW_MS);

  const db = getDb();

  try {
    // Update first, create only if nothing was there. Written this way rather
    // than as an upsert so the two outcomes are distinguishable: a *new* row is
    // a new visit, and that is exactly one more than the cache is holding.
    const updated = await db.visit.updateMany({
      where: { visitorHash: hash, bucket },
      data: { lastSeenAt: now },
    });
    if (updated.count > 0) return "seen";

    await db.visit.create({
      data: { visitorHash: hash, bucket, firstSeenAt: now, lastSeenAt: now },
    });
    bumpCachedVisits();
    return "created";
  } catch {
    // Two renders for the same visitor can land together and race on the unique
    // index. One of them wrote the row, which is the correct outcome — and the
    // loser must not bump the cache, or the count would gain a visit nobody made.
    return "failed";
  }
}

export type Counts = {
  /** Visits since launch. Every one of them a real visitor in a real window. */
  visits: number;
  /** Visitors seen in the last few minutes. Floors at the truth, including zero. */
  online: number;
};

type CacheEntry = { counts: Counts; expiresAt: number };

// Held on globalThis for the same reason the Prisma client is: Next hot-reloads
// modules in development, and a module-local would reset the cache on every
// reload — which would turn "cached" into "queried on every render".
const globalForCounts = globalThis as unknown as {
  topnowCounts?: CacheEntry;
  topnowCountsInFlight?: Promise<Counts>;
};

async function queryCounts(now: Date): Promise<Counts> {
  const db = getDb();
  const since = new Date(now.getTime() - ONLINE_WINDOW_MS);

  const [visits, online] = await Promise.all([
    db.visit.count(),
    // Distinct visitors, not distinct rows: one person's two windows are one
    // person. `_count` on a groupBy would count rows.
    db.visit
      .findMany({
        where: { lastSeenAt: { gte: since } },
        select: { visitorHash: true },
        distinct: ["visitorHash"],
      })
      .then((rows) => rows.length),
  ]);

  return { visits, online };
}

/**
 * The counters, from cache.
 *
 * Single-flighted: when the cache expires and twenty renders arrive at once,
 * they share one query rather than starting twenty. Without that, the cache
 * would do its job everywhere except the moment it matters.
 */
export async function readCounts(now: Date = new Date()): Promise<Counts> {
  const cached = globalForCounts.topnowCounts;
  if (cached && cached.expiresAt > now.getTime()) return cached.counts;

  if (globalForCounts.topnowCountsInFlight) return globalForCounts.topnowCountsInFlight;

  const inFlight = queryCounts(now)
    .then((counts) => {
      globalForCounts.topnowCounts = { counts, expiresAt: now.getTime() + COUNTS_CACHE_MS };
      return counts;
    })
    .catch(() => {
      // A counter that cannot be read renders as what is actually known, which
      // is nothing — and zero is a value this product is willing to print.
      return cached?.counts ?? { visits: 0, online: 0 };
    })
    .finally(() => {
      globalForCounts.topnowCountsInFlight = undefined;
    });

  globalForCounts.topnowCountsInFlight = inFlight;
  return inFlight;
}

/**
 * Correct the cached total by the one visit that was just created.
 *
 * Exactly +1, and only for `visits`. A new row is unambiguously one more visit,
 * so this is arithmetic rather than a guess — and it means the hit counter ticks
 * the moment somebody new arrives instead of up to an interval later.
 *
 * `online` is deliberately left alone. A visitor crossing a bucket boundary
 * while still inside the online window creates a row without becoming a second
 * person, so a +1 there could briefly overstate it — and overstating is the one
 * direction that is not allowed. The next read corrects it downward on its own.
 */
function bumpCachedVisits(): void {
  const cached = globalForCounts.topnowCounts;
  if (cached) cached.counts = { ...cached.counts, visits: cached.counts.visits + 1 };
}

/** Drops the cache. For tests, and for anything that needs a fresh read. */
export function resetCountsCache(): void {
  globalForCounts.topnowCounts = undefined;
  globalForCounts.topnowCountsInFlight = undefined;
}
