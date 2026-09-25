import "server-only";

import { createHash } from "node:crypto";

import type { Purchase, Report } from "@prisma/client";

import { serverConfig } from "@/lib/config/server";
import { getDb } from "@/lib/db";
import { saltDay } from "@/lib/visits/identity";

import type { ReportInput } from "./schema";

/**
 * Storing and reading abuse reports (#17).
 *
 * ## Why a listing can be reported at all
 *
 * TopNow takes money to display someone else's identity at the top of a
 * leaderboard, with their post embedded under it. Nothing in checkout can prove
 * a buyer owns the handle they typed — no platform offers that check for free,
 * and asking for one would put a login wall in front of a product whose whole
 * pitch is that there is no account. So the check happens after the fact, and
 * the report path is how it starts.
 *
 * ## What is stored about the reporter
 *
 * A salted, daily-rotating hash of their address, exactly as #15 stores a
 * visitor. It answers one question — "is this ten people or one person ten
 * times" — which is the question that decides how much weight a pile of reports
 * carries. It does not answer who, and because the salt rotates it cannot be
 * used to follow anyone between days.
 */

/**
 * Derived from `CRON_SECRET` for the same reason the visit counter's salt is:
 * it must be server-side and secret, and adding another required variable is
 * another way for a deployment to fail to start. Distinct from the visit salt so
 * that the two tables cannot be joined on a shared hash — which would turn two
 * unlinkable records into one linked one.
 */
function reporterSalt(): string {
  return `report:${serverConfig().CRON_SECRET}`;
}

export function reporterHash(address: string, now: Date = new Date()): string {
  return createHash("sha256")
    .update(`${reporterSalt()}:${saltDay(now)}:${address}`)
    .digest("hex");
}

export type SubmitOutcome =
  { kind: "recorded"; report: Report } | { kind: "duplicate" } | { kind: "unknown-listing" };

/**
 * Records a report.
 *
 * A second report from the same person about the same listing on the same day is
 * a `duplicate` rather than a second row. Not to be tidy: a queue where one
 * upset person can make a listing look like it has twenty complaints is a queue
 * that mis-sorts real ones, and the reporter is told their report is already in
 * either way.
 */
export async function submitReport(
  input: ReportInput,
  hash: string,
  now: Date = new Date(),
): Promise<SubmitOutcome> {
  const db = getDb();

  const listing = await db.purchase.findUnique({
    where: { id: input.purchaseId },
    select: { id: true },
  });
  if (!listing) return { kind: "unknown-listing" };

  // Any report from this reporter about this listing today, not just an open
  // one. Keying on `status: "open"` meant a dismissal did not stick: the same
  // person could re-file the moment it was closed and put the listing straight
  // back in the queue, which is the pile-on this check exists to prevent. The
  // hash rotates daily, so tomorrow is a fresh report either way — and a
  // reporter with genuinely new information is not silenced, they are told the
  // report is already on file.
  const already = await db.report.findFirst({
    where: { purchaseId: input.purchaseId, reporterHash: hash },
    select: { id: true },
  });
  if (already) return { kind: "duplicate" };

  const report = await db.report.create({
    data: {
      purchaseId: input.purchaseId,
      reason: input.reason,
      detail: input.detail ?? null,
      contact: input.contact ?? null,
      reporterHash: hash,
      createdAt: now,
    },
  });

  return { kind: "recorded", report };
}

export type ReportWithListing = Report & { purchase: Purchase };

/** The queue a human works through: oldest first, because oldest has waited longest. */
export async function openReports(limit = 100): Promise<ReportWithListing[]> {
  return getDb().report.findMany({
    where: { status: "open" },
    orderBy: { createdAt: "asc" },
    take: limit,
    include: { purchase: true },
  });
}

/** Reports already dealt with, most recent first. Kept, never deleted. */
export async function closedReports(limit = 50): Promise<ReportWithListing[]> {
  return getDb().report.findMany({
    where: { status: { not: "open" } },
    orderBy: { reviewedAt: "desc" },
    take: limit,
    include: { purchase: true },
  });
}

/**
 * Closes a report without touching the listing.
 *
 * Writes the audit record in the same transaction as the decision, on the same
 * argument as a kill: a decision with no record of who made it is the one that
 * cannot be defended later. A dismissal is a decision.
 */
export async function dismissReport(
  reportId: string,
  { actor, reason, now = new Date() }: { actor: string; reason: string; now?: Date },
): Promise<Report | null> {
  const db = getDb();

  return db.$transaction(async (tx) => {
    // Guarded on `status: "open"`, so two admins clicking at once produce one
    // decision rather than a second audit record rewriting the first.
    const { count } = await tx.report.updateMany({
      where: { id: reportId, status: "open" },
      data: { status: "dismissed", reviewedAt: now, reviewedBy: actor },
    });
    if (count === 0) return null;

    const closed = await tx.report.findUniqueOrThrow({ where: { id: reportId } });

    // `purchaseId` as well as `reportId`. The audit trail is read as prose —
    // "<who> left up <what>" — and a dismissal that names only a report id has
    // nothing to resolve the listing from, so every one of them rendered as
    // "left up a listing". A record that cannot say which listing answers the
    // question nobody asks.
    await tx.adminAction.create({
      data: { kind: "dismiss", actor, reportId, purchaseId: closed.purchaseId, reason },
    });
    return closed;
  });
}

/** How many open reports each of these listings has. Drives the board's admin view. */
export async function openReportCounts(purchaseIds: string[]): Promise<Map<string, number>> {
  if (purchaseIds.length === 0) return new Map();

  const rows = await getDb().report.groupBy({
    by: ["purchaseId"],
    where: { purchaseId: { in: purchaseIds }, status: "open" },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.purchaseId, row._count._all]));
}
