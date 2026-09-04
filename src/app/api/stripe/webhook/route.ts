import { NextResponse, after, type NextRequest } from "next/server";

import { handleStripeEvent, resolveListingMedia } from "@/lib/payments/webhook";
import { constructWebhookEvent, liveGateway } from "@/lib/payments/stripe";

// Never cached, never statically analysed: this is a write endpoint.
export const dynamic = "force-dynamic";

/**
 * Stripe's webhook endpoint (#26).
 *
 * An unverified webhook endpoint is an unauthenticated write to the purchases
 * table, so nothing is parsed until the signature checks out.
 *
 * `request.text()` is load-bearing: Stripe signs the exact bytes it sent, so the
 * raw body has to reach verification untouched. Reading it as JSON first and
 * re-stringifying produces a body that will not verify — the SDK raises a
 * specific error saying exactly that.
 */
export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "missing signature" }, { status: 400 });
  }

  const rawBody = await request.text();

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (error) {
    // Includes an expired timestamp: Stripe's default 300-second tolerance is
    // what stops a captured signature being replayed later.
    console.warn("[stripe] rejected webhook", (error as Error).message);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handleStripeEvent(event, liveGateway);

    if (outcome.kind === "created") {
      // The avatar and the embed are fetched from third parties, and Stripe's
      // handler has to answer quickly. `after` runs them once this response has
      // gone but while the invocation is still alive — a plain dangling promise
      // can be killed the instant the handler returns, and awaiting them inline
      // risks the function's limit expiring after the purchase has committed
      // but before the 200, which Stripe records as a failed delivery.
      after(() => resolveListingMedia(outcome.media));
    }

    return NextResponse.json({ received: true, outcome: outcome.kind });
  } catch (error) {
    // A 500 tells Stripe to retry, which is what we want for a transient
    // failure — the handler is idempotent, so a retry is safe.
    console.error("[stripe] handler failed", event.type, error);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
