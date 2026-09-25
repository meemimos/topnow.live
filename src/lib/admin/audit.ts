import "server-only";

import type { AdminAction, Platform } from "@prisma/client";

import { getDb } from "@/lib/db";

/**
 * Reading the audit trail (#17).
 *
 * There is deliberately no `write` function here. Every entry is written inside
 * the transaction that performs the action it records — see `killPurchase` and
 * `dismissReport` — because an audit record that can be written separately is one
 * that can be skipped, and the case where it gets skipped is the case it exists
 * for.
 */

export type AuditEntry = AdminAction & {
  /** The listing, when the row names one and it still exists. */
  purchase: {
    platform: Platform;
    handle: string;
    displayName: string | null;
    slot: number;
  } | null;
};

export async function recentAdminActions(limit = 100): Promise<AuditEntry[]> {
  const db = getDb();

  const actions = await db.adminAction.findMany({ orderBy: { createdAt: "desc" }, take: limit });

  const ids = actions.map((action) => action.purchaseId).filter((id): id is string => id !== null);
  const listings =
    ids.length === 0
      ? []
      : await db.purchase.findMany({
          where: { id: { in: ids } },
          select: { id: true, platform: true, handle: true, displayName: true, slot: true },
        });

  const bySelf = new Map(listings.map((row) => [row.id, row]));

  return actions.map((action) => ({
    ...action,
    purchase: action.purchaseId ? (bySelf.get(action.purchaseId) ?? null) : null,
  }));
}
