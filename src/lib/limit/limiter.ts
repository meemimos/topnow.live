import "server-only";

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";

import type { Policy } from "./policy";

/**
 * The rate limiter (#18).
 *
 * ## Shared storage, and what is actually available
 *
 * The issue is explicit: limits are enforced in shared storage, "not
 * per-instance memory, which does nothing behind more than one server". The
 * shared store TopNow already has is Postgres, so that is what this uses. Redis
 * would be the usual answer and would be faster; adding a second stateful
 * dependency to the deployment, for four endpoints that are not hot paths, would
 * be paying an operational cost for latency nobody is measuring.
 *
 * The table is one row per bucket per caller, holding a single timestamp.
 *
 * ## GCRA, not a fixed window
 *
 * A fixed-window counter ("N per hour, reset on the hour") lets a caller spend N
 * at 10:59 and N again at 11:00 — twice the limit across two minutes — and its
 * `Retry-After` is a lie for everyone who arrives mid-window.
 *
 * This is the generic cell rate algorithm instead. One stored value, `tat`, is
 * the time the bucket is "paid up" to. Each request costs `emissionMs` of
 * credit and is allowed while the bucket is no more than `toleranceMs` ahead of
 * now. That gives an exact answer to "when may I try again", which is what makes
 * `Retry-After` truthful rather than a guess rounded to a window boundary.
 *
 * ## Atomicity
 *
 * The decision is one `UPDATE ... WHERE <the bucket allows it>`. Postgres
 * re-evaluates that predicate against the locked, current row, so two concurrent
 * requests cannot both read the same `tat` and both be allowed. The number of
 * rows the statement touched *is* the decision — nothing is read first and
 * written after, because that gap is where a limiter leaks.
 *
 * The row is seeded by a separate statement rather than in a CTE alongside the
 * update: a data-modifying CTE runs against the statement's own snapshot, so the
 * update half would not see the row the insert half had just written.
 *
 * ## What is stored about the caller
 *
 * A truncated sha256 of the bucket and the identity, salted with server-side
 * configuration. The limiter needs to tell callers apart and nothing more, so
 * the table holds no address, no user agent and nothing reversible to either —
 * the same rule #15's counter is built on, for the same reason: a limiter that
 * quietly accumulates a log of visitor IPs is a privacy regression bolted to a
 * safety feature.
 */

export type LimitDecision = {
  allowed: boolean;
  /** How long until the next attempt would be allowed. Zero when allowed. */
  retryAfterMs: number;
  policy: Policy;
};

/**
 * A row is deleted once it has certainly refilled, because a bucket whose `tat`
 * is in the past permits exactly what no row at all permits. Expiry is therefore
 * set to the row's own `tat` plus this margin, so the cleanup job cannot race a
 * request that is mid-flight.
 *
 * Getting that bound wrong would be a silent hole: the pruner would delete a
 * bucket that still had debt and hand a rate-limited caller a fresh budget. The
 * database enforces it too — see `rate_limit_expires_after_tat`.
 */
const EXPIRY_MARGIN_MS = 60_000;

/** Bucket names, so a typo is a compile error rather than a second bucket. */
export type Bucket = "checkout" | "report" | "avatar" | "embed" | "admin";

function keyFor(bucket: Bucket, identity: string, salt: string): string {
  const digest = createHash("sha256").update(`${salt}:${bucket}:${identity}`).digest("hex");
  return `${bucket}:${digest.slice(0, 40)}`;
}

type ConsumeOptions = {
  bucket: Bucket;
  /** Whatever tells one caller from another: an address, a platform, a host. */
  identity: string;
  policy: Policy;
  now?: Date;
  /**
   * Which way to fail when the store itself is unreachable.
   *
   * `allow` for the paths where the limiter protects a budget: if Postgres is
   * down then checkout is already broken and the limiter has nothing left to
   * protect. `deny` for admin authentication, where the limiter is the control
   * and an outage must not be a way to turn it off.
   */
  onFailure?: "allow" | "deny";
  /**
   * The client to use. Injectable so a test can prove that two independently
   * constructed clients — which share no memory, exactly as two servers do not —
   * still share one budget.
   */
  db?: PrismaClient;
  /** Salt for the stored key. Defaults to server configuration. */
  salt?: string;
};

/**
 * Derived from `CRON_SECRET` rather than added as a variable of its own, on the
 * same reasoning as the visit counter's salt: it is a server-side secret that
 * already has to exist, and one more required variable is one more way for a
 * deployment to fail to start.
 */
function currentSalt(): string {
  return `ratelimit:${serverConfig().CRON_SECRET}`;
}

export async function consume(options: ConsumeOptions): Promise<LimitDecision> {
  const { bucket, identity, policy } = options;
  const now = options.now ?? new Date();
  const db = options.db ?? getDb();
  const onFailure = options.onFailure ?? "allow";

  const key = keyFor(bucket, identity, options.salt ?? currentSalt());
  const emissionSec = policy.emissionMs / 1000;
  const toleranceSec = policy.toleranceMs / 1000;
  const marginSec = EXPIRY_MARGIN_MS / 1000;
  // Only used to seed a brand-new row, whose `tat` is `now`.
  const seedExpiry = new Date(now.getTime() + policy.emissionMs + EXPIRY_MARGIN_MS);

  const args = { db, key, now, emissionSec, toleranceSec, marginSec };

  try {
    const taken = await take(args);
    if (taken) return { allowed: true, retryAfterMs: 0, policy };

    const existing = await db.rateLimit.findUnique({ where: { key }, select: { tat: true } });
    if (!existing) {
      // No row, so nothing refused this — the bucket had simply never been used.
      // Seed it and take the first token.
      await db.rateLimit.createMany({
        data: [{ key, tat: now, expiresAt: seedExpiry }],
        skipDuplicates: true,
      });
      const seeded = await take(args);
      if (seeded) return { allowed: true, retryAfterMs: 0, policy };
      return { allowed: false, retryAfterMs: policy.emissionMs, policy };
    }

    // The bucket is `tat` ahead of the sustained rate; it lets the next request
    // through once that debt falls back inside the tolerance.
    const readyAt = existing.tat.getTime() + policy.emissionMs - policy.toleranceMs;
    return { allowed: false, retryAfterMs: Math.max(0, readyAt - now.getTime()), policy };
  } catch (error) {
    console.warn(`[limit] ${bucket} could not be evaluated`, error);
    return { allowed: onFailure === "allow", retryAfterMs: policy.emissionMs, policy };
  }
}

/**
 * One request's worth of credit, taken atomically.
 *
 * Returns whether the bucket allowed it. The `WHERE` clause is the whole
 * decision: Postgres re-checks it against the locked current row, so of two
 * concurrent callers with one token between them exactly one updates a row.
 */
async function take(args: {
  db: PrismaClient;
  key: string;
  now: Date;
  emissionSec: number;
  toleranceSec: number;
  marginSec: number;
}): Promise<boolean> {
  const { db, key, now, emissionSec, toleranceSec, marginSec } = args;

  // The new `tat` expression is written twice rather than once into a variable,
  // because expiry has to be derived from *this* row's new value. Computing it
  // in TypeScript from the policy would be right only while the policy is the
  // one that wrote the row — lower a burst in a deploy and the arithmetic goes
  // the wrong way, `rate_limit_expires_after_tat` rejects the update, and the
  // bucket starts failing for as long as the old row survives.
  const rows = await db.$queryRaw<{ tat: Date }[]>`
    UPDATE rate_limit
       SET tat = GREATEST(tat, ${now}::timestamptz)
                 + make_interval(secs => ${emissionSec}::double precision),
           "expiresAt" = GREATEST(tat, ${now}::timestamptz)
                 + make_interval(secs => ${emissionSec}::double precision)
                 + make_interval(secs => ${marginSec}::double precision)
     WHERE key = ${key}
       AND GREATEST(tat, ${now}::timestamptz)
           + make_interval(secs => ${emissionSec}::double precision)
           - make_interval(secs => ${toleranceSec}::double precision)
           <= ${now}::timestamptz
    RETURNING tat
  `;

  return rows.length > 0;
}

/**
 * Drops buckets that have refilled. Called from the hourly job (#22).
 *
 * Deleting a fully refilled bucket loses nothing: a row whose `tat` is in the
 * past permits exactly what no row at all permits.
 */
export async function pruneExpiredLimits(now: Date = new Date()): Promise<number> {
  const { count } = await getDb().rateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
