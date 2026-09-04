import { NextResponse, type NextRequest } from "next/server";

import { currentAdmin, sameOrigin } from "@/lib/admin/auth";
import { adminConfigured } from "@/lib/config/server";
import { dismissReport } from "@/lib/reports/store";

export const dynamic = "force-dynamic";

/**
 * Closing a report without touching the listing (#17).
 *
 * Audited like a kill is. Deciding that a listing stays is a decision, and the
 * record of who made it is worth the same as the record of a takedown — arguably
 * more, since it is the one that gets asked about if the report turns out to
 * have been right.
 */
export async function POST(request: NextRequest) {
  if (!adminConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!sameOrigin(request.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    reportId?: unknown;
    reason?: unknown;
  } | null;

  const reportId = typeof body?.reportId === "string" ? body.reportId : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  if (!reportId) return NextResponse.json({ message: "Which report?" }, { status: 400 });
  if (!reason) return NextResponse.json({ message: "A reason is required." }, { status: 400 });
  if (reason.length > 500) {
    return NextResponse.json({ message: "Keep the reason under 500 characters." }, { status: 400 });
  }

  const closed = await dismissReport(reportId, { actor: admin.username, reason });
  if (!closed) {
    // Already dealt with, by this admin or another one. Not an error — the
    // report is closed, which is what the caller wanted.
    return NextResponse.json({ ok: true, alreadyClosed: true });
  }

  return NextResponse.json({ ok: true, alreadyClosed: false });
}
