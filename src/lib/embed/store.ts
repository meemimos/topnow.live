import "server-only";

import type { Embed, EmbedStatus, Platform } from "@prisma/client";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";
import { consume } from "@/lib/limit/limiter";
import type { Transport } from "@/lib/fetch/net";

import {
  REFRESH_AFTER_MS,
  REFRESH_BATCH,
  REFRESH_BUDGET_MS,
  RETRY_FAILED_AFTER_MS,
} from "./constants";
import { normalisePostUrl } from "./providers";
import { resolveEmbed } from "./resolve";

/**
 * The embed cache (#20).
 *
 * Same shape and same rule as the avatar cache: resolution on submit and on the
 * hourly job, reads on every render, and never the other way round. Negative
 * results are cached too, which the issue asks for explicitly — a permanently
 * unresolvable post must not be retried on every refresh.
 */

export function isStale(embed: Pick<Embed, "status" | "resolvedAt">, now: Date): boolean {
  const age = now.getTime() - embed.resolvedAt.getTime();
  switch (embed.status) {
    case "ok":
      return age >= REFRESH_AFTER_MS;
    case "failed":
      return age >= RETRY_FAILED_AFTER_MS;
    // A deleted post stays deleted; a platform with no provider stays that way.
    case "unavailable":
      return false;
  }
}

type EmbedFields = {
  status: EmbedStatus;
  title: string | null;
  authorName: string | null;
  iframeSrc: string | null;
  iframeWidth: number | null;
  iframeHeight: number | null;
  thumbnail: Uint8Array<ArrayBuffer> | null;
  thumbnailWidth: number | null;
  providerViews: number | null;
  failureReason: string | null;
  attempts: number;
  resolvedAt: Date;
};

function truncate(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497)}...` : reason;
}

function rowFor(
  outcome: Awaited<ReturnType<typeof resolveEmbed>>,
  { now, previousAttempts }: { now: Date; previousAttempts: number },
): EmbedFields {
  const blank = {
    title: null,
    authorName: null,
    iframeSrc: null,
    iframeWidth: null,
    iframeHeight: null,
    thumbnail: null,
    thumbnailWidth: null,
    providerViews: null,
    resolvedAt: now,
  } as const;

  switch (outcome.kind) {
    case "resolved":
      return { ...outcome.embed, status: "ok", failureReason: null, attempts: 0, resolvedAt: now };
    case "unavailable":
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

/**
 * Resolve and store, unless a fresh answer is already on hand.
 *
 * Never throws. Called from the Stripe webhook, where an exception would turn a
 * provider's bad minute into a purchase that did not record — and an unresolved
 * embed is not a failure, it is slot 01 rendering as a profile card.
 */
export async function ensureEmbed(
  platform: Platform,
  rawPostUrl: string,
  options: { now?: Date; transport?: Transport; force?: boolean } = {},
): Promise<Embed | null> {
  const now = options.now ?? new Date();
  const db = getDb();

  let postUrl: string;
  try {
    postUrl = normalisePostUrl(platform, rawPostUrl);
  } catch {
    // A URL that does not validate has nothing to resolve and nothing worth
    // caching under a key it would not produce.
    return null;
  }

  try {
    const existing = await db.embed.findUnique({ where: { postUrl } });
    if (existing && !options.force && !isStale(existing, now)) return existing;

    // Same rule as the avatar cache (#18): a cache hit costs nothing, only an
    // actual oEmbed request does. Keyed by platform, because the budget being
    // protected is the provider's.
    const gate = await consume({
      bucket: "embed",
      identity: platform,
      policy: serverConfig().RATE_LIMIT_EMBED,
      now,
    });
    if (!gate.allowed) {
      console.warn(
        `[embed] ${postUrl} deferred: resolution limit reached, ` +
          `retry in ${Math.ceil(gate.retryAfterMs / 1000)}s`,
      );
      return existing ?? null;
    }

    const outcome = await resolveEmbed(platform, postUrl, { transport: options.transport });
    const row = rowFor(outcome, { now, previousAttempts: existing?.attempts ?? 0 });

    if (outcome.kind === "failed") {
      // The post URL and the reason, never the provider's response body.
      console.warn(`[embed] ${postUrl} failed (attempt ${row.attempts}): ${outcome.reason}`);
    }

    return await db.embed.upsert({
      where: { postUrl },
      create: { postUrl, platform, ...row },
      update: row,
    });
  } catch (error) {
    console.warn(
      `[embed] ${postUrl} could not be stored: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return null;
  }
}

/**
 * What slot 01 needs to render the panel. No markup, no third-party URL that
 * the page would fetch on load.
 */
export type BoardEmbed = {
  id: string;
  title: string | null;
  authorName: string | null;
  iframeSrc: string;
  iframeWidth: number | null;
  iframeHeight: number | null;
  hasThumbnail: boolean;
  thumbnailVersion: number;
  providerViews: number | null;
};

/**
 * Read one listing's embed. A query, never a resolution.
 *
 * Returns `null` for anything not renderable — no post URL, no row yet, a
 * failure, a deleted post. Slot 01 has one branch to write, and it is the branch
 * that renders a complete profile card.
 */
export async function readEmbed(
  listing: { platform: Platform; postUrl: string | null } | null,
): Promise<BoardEmbed | null> {
  if (!listing?.postUrl) return null;

  let postUrl: string;
  try {
    postUrl = normalisePostUrl(listing.platform, listing.postUrl);
  } catch {
    return null;
  }

  const row = await getDb().embed.findUnique({
    where: { postUrl },
    select: {
      id: true,
      status: true,
      title: true,
      authorName: true,
      iframeSrc: true,
      iframeWidth: true,
      iframeHeight: true,
      thumbnailWidth: true,
      providerViews: true,
      updatedAt: true,
    },
  });

  if (!row || row.status !== "ok" || !row.iframeSrc) return null;

  return {
    id: row.id,
    title: row.title,
    authorName: row.authorName,
    iframeSrc: row.iframeSrc,
    iframeWidth: row.iframeWidth,
    iframeHeight: row.iframeHeight,
    hasThumbnail: row.thumbnailWidth !== null,
    thumbnailVersion: row.updatedAt.getTime(),
    providerViews: row.providerViews,
  };
}

export type EmbedRefreshSummary = {
  considered: number;
  resolved: number;
  failed: number;
  /** Held back by the resolution limit (#18). Not a failure — see RefreshSummary. */
  deferred: number;
};

const EMPTY_SUMMARY: EmbedRefreshSummary = { considered: 0, resolved: 0, failed: 0, deferred: 0 };

/**
 * Re-resolve embeds that have gone stale, for listings that are still live or
 * queued. A post whose rental ended months ago will not be rendered, so asking
 * a provider about it again spends someone else's budget for nothing.
 */
export async function refreshStaleEmbeds(
  now: Date = new Date(),
  options: { transport?: Transport; limit?: number; budgetMs?: number } = {},
): Promise<EmbedRefreshSummary> {
  const limit = options.limit ?? REFRESH_BATCH;
  const deadline = Date.now() + (options.budgetMs ?? REFRESH_BUDGET_MS);
  const db = getDb();

  const active = await db.purchase.findMany({
    where: { status: { in: ["queued", "live"] }, postUrl: { not: null } },
    select: { platform: true, postUrl: true },
    distinct: ["platform", "postUrl"],
  });
  if (active.length === 0) return EMPTY_SUMMARY;

  const keys = new Map<string, Platform>();
  for (const listing of active) {
    try {
      keys.set(normalisePostUrl(listing.platform, listing.postUrl!), listing.platform);
    } catch {
      // A row written before the validation tightened. Nothing to refresh.
    }
  }
  if (keys.size === 0) return EMPTY_SUMMARY;

  // Every row that exists, whatever its status. `unavailable` is settled and is
  // not rescanned, but it still counts as tried — this is the set to subtract
  // from, not the set to refresh.
  const existing = await db.embed.findMany({
    where: { postUrl: { in: [...keys.keys()] } },
    select: { postUrl: true, platform: true, status: true, resolvedAt: true },
    orderBy: { resolvedAt: "asc" },
  });

  const known = new Set(existing.map((row) => row.postUrl));

  // Same hole as the avatar cache had: the first attempt happens in the Stripe
  // webhook, and a post the resolution limit (#18) deferred there has no row —
  // so a refresher scanning only existing rows would never come back to it, and
  // slot 01 would render as a profile card for the whole rental with nothing
  // recording why.
  const untried = [...keys.entries()]
    .filter(([postUrl]) => !known.has(postUrl))
    .map(([postUrl, platform]) => ({ postUrl, platform }));

  const stale = [
    ...untried,
    ...existing.filter((row) => row.status !== "unavailable" && isStale(row, now)),
  ].slice(0, limit);

  let resolved = 0;
  let failed = 0;
  let deferred = 0;

  // Sequential, like the avatar refresh: parallel requests to one provider is
  // how a refresh pass becomes the thing that gets the product rate-limited.
  // Bounded by wall clock too — see the same loop in the avatar store.
  for (const row of stale) {
    if (Date.now() >= deadline) break;
    const updated = await ensureEmbed(row.platform, row.postUrl, {
      now,
      transport: options.transport,
    });

    // A deferral hands back the untouched row, whose `resolvedAt` predates this
    // pass. Without that comparison a throttled tick reported every row it
    // skipped as resolved.
    if (updated === null) failed += 1;
    else if (updated.resolvedAt.getTime() !== now.getTime()) deferred += 1;
    else if (updated.status === "ok") resolved += 1;
    else failed += 1;
  }

  return { considered: stale.length, resolved, failed, deferred };
}
