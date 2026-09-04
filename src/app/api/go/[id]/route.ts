import { NextResponse } from "next/server";

import { recordClick } from "@/lib/embed/clicks";

export const dynamic = "force-dynamic";

/**
 * The outbound link, counted (#20).
 *
 * The footer prints a click count, and #20 requires it to be TopNow's own
 * measurement rather than a figure borrowed from a platform. This route is that
 * measurement: it records the click and forwards to the listing's own target.
 *
 * ## Why a redirect rather than a beacon
 *
 * A `sendBeacon` on click is invisible to the user but lost whenever the page is
 * unloaded first, which is most of the time on a link that opens elsewhere. A
 * count that silently under-reports is worse than no count, because it still
 * looks like a number.
 *
 * The destination is read from the purchase row, never from the query string.
 * A redirector that forwards to a URL in its own parameters is an open redirect,
 * and an open redirect on a domain people are asked to trust with a payment is
 * worth more to a phisher than the leaderboard is to anyone.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The user agent decides whether this counts, not whether it forwards (#15's
  // bot rule). A preview unfurler following the link is not a person clicking
  // it, and clicks are the one engagement number the product prints.
  const target = await recordClick(id, request.headers.get("user-agent"));
  if (!target) return new NextResponse("Not found", { status: 404 });

  return NextResponse.redirect(target, {
    status: 302,
    headers: {
      // Never cached: a cached redirect is a click that happens without being
      // counted, which would make the number quietly wrong over time.
      "cache-control": "no-store",
      // The destination does not need to learn which listing sent the visitor.
      "referrer-policy": "no-referrer",
    },
  });
}
