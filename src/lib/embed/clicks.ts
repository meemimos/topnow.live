import "server-only";

import { getDb } from "@/lib/db";

/**
 * Click counting (#20).
 *
 * The only engagement figure the product can measure for itself, which is why it
 * is the only one it is allowed to print. Views come from a provider or are
 * absent; clicks are ours.
 */

/**
 * Record a click and return where to send the visitor.
 *
 * The increment and the read are one statement, so a click cannot be counted for
 * a listing that does not exist, and the destination cannot be read from a row
 * that was deleted between the two.
 *
 * Counting is best-effort by design: if the update fails, the visitor is still
 * forwarded. A broken counter must not become a broken link.
 */
export async function recordClick(purchaseId: string): Promise<string | null> {
  const db = getDb();

  try {
    const updated = await db.purchase.update({
      where: { id: purchaseId },
      data: { clicks: { increment: 1 } },
      select: { targetUrl: true },
    });
    return updated.targetUrl;
  } catch {
    // Either the row is gone, or the write failed. Fall back to a plain read so
    // a counting problem never costs the buyer their traffic.
    const row = await db.purchase
      .findUnique({ where: { id: purchaseId }, select: { targetUrl: true } })
      .catch(() => null);
    return row?.targetUrl ?? null;
  }
}

/** Where the board points a listing's link. */
export function clickThroughHref(purchaseId: string): string {
  return `/api/go/${purchaseId}`;
}
