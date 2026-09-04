import { notFound, redirect } from "next/navigation";

import {
  AdminConsole,
  type AuditRow,
  type ListingRow,
  type ReportRow,
} from "@/components/admin/console";
import { displayNameFor } from "@/components/board/platform";
import { currentAdmin } from "@/lib/admin/auth";
import { recentAdminActions } from "@/lib/admin/audit";
import { adminConfigured } from "@/lib/config/server";
import { getDb } from "@/lib/db";
import { openReportCounts, openReports } from "@/lib/reports/store";
import type { ReportReasonValue } from "@/lib/reports/schema";

export const dynamic = "force-dynamic";

export const metadata = { title: "TopNow admin", robots: { index: false, follow: false } };

/**
 * The admin surface (#17).
 *
 * Two gates, in this order:
 *
 *   1. `notFound()` when the admin surface is not configured. A deployment that
 *      has not set the credentials does not have an admin panel, and this must
 *      not be a more forgiving state than being signed out.
 *   2. `redirect()` to sign-in when nobody is signed in. Nothing below this line
 *      runs — no query, no listing, no report — so an unauthenticated request
 *      never causes a read of the data this page exists to show.
 *
 * The API routes repeat both checks. This page is a view; the routes are the
 * boundary, and a boundary that trusts a page not to have been bypassed is not
 * one.
 */
export default async function AdminPage() {
  if (!adminConfigured()) notFound();

  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");

  const db = getDb();

  const [reports, listings, audit] = await Promise.all([
    openReports(),
    db.purchase.findMany({
      where: { status: { in: ["live", "queued"] } },
      orderBy: [{ slot: "asc" }, { boughtAt: "asc" }],
      take: 60,
    }),
    recentAdminActions(60),
  ]);

  const counts = await openReportCounts([
    ...new Set([...reports.map((row) => row.purchaseId), ...listings.map((row) => row.id)]),
  ]);

  const reportRows: ReportRow[] = reports.map((report) => ({
    id: report.id,
    purchaseId: report.purchaseId,
    reason: report.reason as ReportReasonValue,
    detail: report.detail,
    contact: report.contact,
    createdAtMs: report.createdAt.getTime(),
    listing: {
      name: displayNameFor(report.purchase),
      slot: report.purchase.slot,
      status: report.purchase.status,
      tagline: report.purchase.tagline,
      targetUrl: report.purchase.targetUrl,
    },
    reportsOnListing: counts.get(report.purchaseId) ?? 1,
  }));

  const listingRows: ListingRow[] = listings.map((listing) => ({
    id: listing.id,
    name: displayNameFor(listing),
    slot: listing.slot,
    status: listing.status,
    tagline: listing.tagline,
    targetUrl: listing.targetUrl,
    openReports: counts.get(listing.id) ?? 0,
  }));

  const auditRows: AuditRow[] = audit.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    actor: entry.actor,
    reason: entry.reason,
    createdAtMs: entry.createdAt.getTime(),
    subject: entry.purchase
      ? `slot ${String(entry.purchase.slot).padStart(2, "0")} — ${displayNameFor(entry.purchase)}`
      : null,
  }));

  return (
    <main className="mx-auto flex max-w-[860px] flex-col px-2 pt-4 pb-10">
      <h1 className="text-2xl mt-0 mb-3 font-bold text-paper">TopNow admin</h1>
      <AdminConsole
        admin={admin.username}
        reports={reportRows}
        listings={listingRows}
        audit={auditRows}
      />
    </main>
  );
}
