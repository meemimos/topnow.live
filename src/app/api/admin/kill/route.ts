import { NextResponse, type NextRequest } from "next/server";

import { currentAdmin, sameOrigin } from "@/lib/admin/auth";
import { adminConfigured } from "@/lib/config/server";
import { NotKillableError, killPurchase } from "@/lib/purchase/state";

export const dynamic = "force-dynamic";

/**
 * The kill switch (#17).
 *
 * One call takes a listing off the board, frees the slot, promotes whoever is
 * next, closes any open reports about it and writes the audit record — in one
 * transaction, so there is no interleaving in which a listing is removed without
 * a record of who removed it, and none in which a slot sits empty with a queue
 * behind it.
 *
 * Decision D4: no refund. The remaining hours are forfeited, which is why the
 * terms and the checkout say so before anyone pays.
 */
export async function POST(request: NextRequest) {
  if (!adminConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!sameOrigin(request.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  const admin = await currentAdmin();
  // 404 rather than 401: an unauthenticated caller learns that this path is not
  // theirs, and nothing about whether it is anybody's.
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    purchaseId?: unknown;
    reason?: unknown;
    reportId?: unknown;
  } | null;

  const purchaseId = typeof body?.purchaseId === "string" ? body.purchaseId : "";
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const reportId = typeof body?.reportId === "string" ? body.reportId : undefined;

  if (!purchaseId) return NextResponse.json({ message: "Which listing?" }, { status: 400 });
  if (!reason) {
    // The audit trail's value is that every entry answers why. A takedown with
    // no stated reason is the entry that gets quoted back when it is challenged.
    return NextResponse.json({ message: "A reason is required." }, { status: 400 });
  }
  if (reason.length > 500) {
    return NextResponse.json({ message: "Keep the reason under 500 characters." }, { status: 400 });
  }

  try {
    const outcome = await killPurchase(purchaseId, { actor: admin.username, reason, reportId });
    return NextResponse.json({
      ok: true,
      promoted: outcome.promoted?.id ?? null,
      reportsUpheld: outcome.reportsUpheld,
    });
  } catch (error) {
    if (error instanceof NotKillableError) {
      return NextResponse.json(
        {
          message:
            error.status === "killed"
              ? "That listing is already off the board."
              : "That rental has already ended, and the tape is not rewritten.",
        },
        { status: 409 },
      );
    }
    console.error("[admin/kill] failed", error);
    return NextResponse.json({ message: "That did not go through." }, { status: 500 });
  }
}
