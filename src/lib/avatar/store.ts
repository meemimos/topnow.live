import "server-only";

import type { Avatar, AvatarStatus, Platform } from "@prisma/client";

import { getDb } from "@/lib/db";

import { REFRESH_AFTER_MS, REFRESH_BUDGET_MS, RETRY_FAILED_AFTER_MS } from "./constants";
import { resolveAvatar } from "./resolve";
import type { Transport } from "@/lib/fetch/net";

/**
 * The avatar cache (#19).
 *
 * The whole point of this file is the direction of the arrows: **writes happen
 * on submit and on the refresh schedule; reads happen on every board render and
 * never cause a fetch.** Resolving on read would make the board's latency a
 * function of a third party's, and would burn the rate-limit budget (#18) once
 * per visitor rather than once per account.
 */

/**
 * The cache key.
 *
 * Case-folded because platforms treat handles case-insensitively — `@Mira` and
 * `@mira` are one account, and two rows for one account means two fetches, two
 * rate-limit hits and a coin toss over which the board shows. The database
 * enforces the same rule (`avatar_handle_lowercase`).
 */
export function avatarKey(handle: string): string {
  return handle.toLowerCase();
}

/** Whether a cached row is old enough to be worth resolving again. */
export function isStale(avatar: Pick<Avatar, "status" | "resolvedAt">, now: Date): boolean {
  const age = now.getTime() - avatar.resolvedAt.getTime();
  switch (avatar.status) {
    case "ok":
      return age >= REFRESH_AFTER_MS;
    case "failed":
      return age >= RETRY_FAILED_AFTER_MS;
    // `unavailable` is a settled answer — no resolver for the platform, or the
    // bytes were not an image. Re-asking produces the same answer, so the only
    // thing a retry would spend is somebody else's rate limit.
    case "unavailable":
      return false;
  }
}

/**
 * The mutable half of an avatar row.
 *
 * Spelled out rather than reached for from Prisma's generated input types,
 * because this is the shape both the create and the update must agree on: every
 * field is written on every resolution, so a row can never carry a mix of this
 * attempt's status and the last one's bytes.
 */
type AvatarFields = {
  status: AvatarStatus;
  contentType: string | null;
  large: Uint8Array<ArrayBuffer> | null;
  small: Uint8Array<ArrayBuffer> | null;
  sourceUrl: string | null;
  failureReason: string | null;
  attempts: number;
  resolvedAt: Date;
};

function rowFor(
  outcome: Awaited<ReturnType<typeof resolveAvatar>>,
  { now, previousAttempts }: { now: Date; previousAttempts: number },
): AvatarFields {
  const blank = {
    contentType: null,
    large: null,
    small: null,
    sourceUrl: null,
    resolvedAt: now,
  } as const;

  switch (outcome.kind) {
    case "resolved":
      return {
        status: "ok",
        contentType: outcome.encoded.contentType,
        large: outcome.encoded.large,
        small: outcome.encoded.small,
        sourceUrl: outcome.sourceUrl,
        failureReason: null,
        attempts: 0,
        resolvedAt: now,
      };

    case "unavailable":
      // A settled answer, so the attempt counter resets: this is not a run of
      // failures, it is a fact about the account.
      return {
        ...blank,
        status: "unavailable",
        failureReason: truncate(outcome.reason),
        attempts: 0,
      };

    case "failed":
      return {
        ...blank,
        status: "failed",
        failureReason: truncate(outcome.reason),
        attempts: previousAttempts + 1,
      };
  }
}

/** The column is VARCHAR(500); a long upstream message must not fail the write. */
function truncate(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

/**
 * Resolve and store, unless a fresh answer is already on hand.
 *
 * Never throws. It is called from the Stripe webhook, where an exception would
 * turn "avatar host is having a bad day" into "the payment did not record" — and
 * the whole design of #19 is that a missing avatar is a designed state, not a
 * failure. The outcome is written to the row and, on a genuine failure, logged.
 */
export async function ensureAvatar(
  platform: Platform,
  rawHandle: string,
  options: { now?: Date; transport?: Transport; force?: boolean } = {},
): Promise<Avatar | null> {
  const now = options.now ?? new Date();
  const handle = avatarKey(rawHandle);
  const db = getDb();

  // A website listing carries an empty handle by design (#21), and the avatar
  // table requires a non-empty one. Without this the upsert violated
  // `avatar_handle_present` on every single website purchase — caught and
  // swallowed by the handler below, so it was a silent guaranteed-failing write
  // rather than a loud one. There is also nothing to key a row on.
  if (!handle) return null;

  try {
    const existing = await db.avatar.findUnique({
      where: { platform_handle: { platform, handle } },
    });
    if (existing && !options.force && !isStale(existing, now)) return existing;

    const outcome = await resolveAvatar(platform, rawHandle, { transport: options.transport });
    const row = rowFor(outcome, { now, previousAttempts: existing?.attempts ?? 0 });

    if (outcome.kind === "failed") {
      // Enough to debug with, and deliberately not the upstream response: the
      // body of a failed fetch is attacker-controlled and does not belong in a
      // log that someone will later grep.
      console.warn(
        `[avatar] ${platform}/${handle} failed (attempt ${row.attempts}): ${outcome.reason}`,
      );
    }

    return await db.avatar.upsert({
      where: { platform_handle: { platform, handle } },
      create: { platform, handle, ...row },
      update: row,
    });
  } catch (error) {
    // Includes the unique-violation race where two webhook deliveries for the
    // same handle land together. One of them wrote a row, which is the correct
    // outcome; the loser has nothing to do.
    console.warn(
      `[avatar] ${platform}/${handle} could not be stored: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return null;
  }
}

/**
 * What the board needs to build an image URL.
 *
 * `version` is the row's `updatedAt` in epoch milliseconds. It rides in the
 * query string so the stored bytes can be served `immutable` — the id is stable
 * across a refresh but the bytes are not, and a URL that never changes while its
 * content does is a stale avatar nobody can flush.
 */
export type BoardAvatar = { id: string; version: number };

/**
 * Look up avatars for a set of listings. One query, no fetches.
 *
 * Returns a map keyed by `platform:handle`, holding only rows that actually have
 * bytes — a `failed` or `unavailable` row is indistinguishable from no row at
 * all as far as rendering is concerned, and collapsing them here means the board
 * has one case to handle rather than four.
 */
export async function readAvatars(
  listings: ReadonlyArray<{ platform: Platform; handle: string }>,
): Promise<Map<string, BoardAvatar>> {
  const wanted = listings.map((listing) => ({
    platform: listing.platform,
    handle: avatarKey(listing.handle),
  }));
  if (wanted.length === 0) return new Map();

  const rows = await getDb().avatar.findMany({
    where: { status: "ok", OR: wanted },
    select: { id: true, platform: true, handle: true, updatedAt: true },
  });

  return new Map(
    rows.map((row) => [
      `${row.platform}:${row.handle}`,
      { id: row.id, version: row.updatedAt.getTime() },
    ]),
  );
}

export function avatarLookupKey(listing: { platform: Platform; handle: string }): string {
  return `${listing.platform}:${avatarKey(listing.handle)}`;
}

/**
 * How many stale rows one refresh pass will touch.
 *
 * Bounded because this runs inside the hourly job's request (#22): an unbounded
 * pass over a table that grows with the customer list would eventually exceed
 * the scheduler's timeout, and a job that times out half way is a job that
 * refreshes the same first N rows forever.
 */
export const REFRESH_BATCH = 20;

export type RefreshSummary = { considered: number; resolved: number; failed: number };

/**
 * Re-resolve the avatars that have gone stale.
 *
 * Called from the hourly job, never from a read — that is the whole rule of #19,
 * and putting the only other caller of `ensureAvatar` here keeps it visible.
 *
 * Only rows for accounts that still matter are refreshed: a handle whose last
 * rental ended months ago is not going to be rendered, so spending an upstream
 * request on it is spending someone else's rate limit for nothing.
 */
export async function refreshStaleAvatars(
  now: Date = new Date(),
  options: { transport?: Transport; limit?: number; budgetMs?: number } = {},
): Promise<RefreshSummary> {
  const limit = options.limit ?? REFRESH_BATCH;
  const deadline = Date.now() + (options.budgetMs ?? REFRESH_BUDGET_MS);
  const db = getDb();

  const active = await db.purchase.findMany({
    where: { status: { in: ["queued", "live"] } },
    select: { platform: true, handle: true },
    distinct: ["platform", "handle"],
  });
  if (active.length === 0) return { considered: 0, resolved: 0, failed: 0 };

  const rows = await db.avatar.findMany({
    where: {
      OR: active.map((listing) => ({
        platform: listing.platform,
        handle: avatarKey(listing.handle),
      })),
      // `unavailable` is a settled answer and is deliberately not rescanned.
      status: { in: ["ok", "failed"] },
    },
    select: { platform: true, handle: true, status: true, resolvedAt: true },
    orderBy: { resolvedAt: "asc" },
    take: limit,
  });

  const stale = rows.filter((row) => isStale(row, now));
  let resolved = 0;
  let failed = 0;

  // Sequential on purpose. Three parallel requests to one host is how a refresh
  // pass turns into the thing that gets the resolver rate-limited (#18).
  //
  // Bounded by wall clock as well as by count, because the count alone does not
  // bound the time: twenty rows each timing out at four seconds is eighty
  // seconds inside one scheduled request. Whatever is left over is simply still
  // stale, and the next tick starts with it — the query is ordered oldest-first.
  for (const row of stale) {
    if (Date.now() >= deadline) break;
    const updated = await ensureAvatar(row.platform, row.handle, {
      now,
      transport: options.transport,
    });
    if (updated?.status === "ok") resolved += 1;
    else failed += 1;
  }

  return { considered: stale.length, resolved, failed };
}
