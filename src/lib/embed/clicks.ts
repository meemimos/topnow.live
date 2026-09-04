import "server-only";

import { getDb } from "@/lib/db";
import { looksLikeABot } from "@/lib/visits/identity";

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
 *
 * ## Bots are forwarded but not counted
 *
 * `userAgent` is filtered by the same rule the visit counter uses (#15). A link
 * checker, a preview unfurler or a crawler following this URL is not a person
 * clicking it, and this is the one engagement figure the product actually
 * prints — so it is the one that must not be inflated. It errs downward, like
 * the visit count: a real person with an odd user agent is forwarded and simply
 * not counted.
 */
export async function recordClick(
  purchaseId: string,
  /** Required rather than defaulted: a caller that forgot it would silently
      stop counting, which is a worse failure than a compile error. */
  userAgent: string | null,
): Promise<string | null> {
  const db = getDb();

  if (looksLikeABot(userAgent)) {
    // Forwarded regardless. The buyer paid for the traffic; only the number is
    // ours to withhold.
    const row = await db.purchase
      .findUnique({ where: { id: purchaseId }, select: { targetUrl: true } })
      .catch(() => null);
    return row?.targetUrl ?? null;
  }

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
