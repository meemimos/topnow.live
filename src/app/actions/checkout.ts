"use server";

import { fieldErrors, parseCheckout } from "@/lib/checkout/schema";
import { serverConfig, stripeConfigured } from "@/lib/config/server";
import { liveGateway } from "@/lib/payments/stripe";
import { getDb } from "@/lib/db";
import {
  QUEUE_CAP_HOURS,
  SLOTS,
  quoteForQueue,
  type DurationHours,
  type Slot,
} from "@/lib/pricing";
import { acceptsNewBookings, queuedHoursForSlot, waitHoursForSlot } from "@/lib/purchase/queue";

/**
 * Server-side validation and pricing for the checkout form (#8).
 *
 * The form validates as a convenience; this is the boundary. A form is not a
 * security check — anyone can post whatever they like to it — so everything is
 * parsed again here, and the price is computed here rather than accepted from
 * the client.
 *
 * Creating the Stripe session, and with it the purchase, is #26. This returns
 * the quote the buyer is about to be charged, so #9's receipt and #10's queue
 * position have something real to render, and refuses anything the rules would.
 */

export type CheckoutQuote = {
  slot: Slot;
  durationH: DurationHours;
  multiplierCm: number;
  askHrCents: number;
  totalCents: number;
  /** Hours a buyer joining now would wait. Drives #10's position copy. */
  waitHours: number;
  queuedHours: number;
  queuedAhead: number;
  /** True when the slot is free, so the listing goes live immediately. */
  immediate: boolean;
};

export type CheckoutResult =
  { ok: true; quote: CheckoutQuote } | { ok: false; errors: Record<string, string> };

export type StartPaymentResult =
  { ok: true; url: string } | { ok: false; errors: Record<string, string> };

export async function priceCheckout(input: unknown): Promise<CheckoutResult> {
  const parsed = parseCheckout(input);
  if (!parsed.success) {
    return { ok: false, errors: fieldErrors(parsed.error) };
  }

  const slot = parsed.data.slot as Slot;
  const durationH = parsed.data.durationH as DurationHours;

  const db = getDb();
  const now = new Date();

  const [waitHours, queuedHours, queuedAhead] = await Promise.all([
    waitHoursForSlot(db, slot, now),
    queuedHoursForSlot(db, slot),
    db.purchase.count({ where: { slot, status: "queued" } }),
  ]);

  // Refused before payment is taken, never after (#24). A full slot is a state
  // the buyer gets explained (#10), not an unexplained disabled button, so the
  // message says when it next opens and what else is available.
  if (!acceptsNewBookings(waitHours)) {
    const opensIn = Math.ceil(waitHours - QUEUE_CAP_HOURS);
    const alternatives = (
      await Promise.all(
        SLOTS.filter((other) => other !== slot).map(async (other) => ({
          slot: other,
          wait: await waitHoursForSlot(db, other, now),
        })),
      )
    )
      .filter((other) => acceptsNewBookings(other.wait))
      .map((other) => `slot ${String(other.slot).padStart(2, "0")}`);

    return {
      ok: false,
      errors: {
        form:
          `Slot ${String(slot).padStart(2, "0")} is full. The wait is already ` +
          `${Math.round(waitHours)}h, past the ${QUEUE_CAP_HOURS}h cap, so it is not taking ` +
          `bookings for about another ${opensIn}h. ` +
          (alternatives.length > 0
            ? `${alternatives.join(" and ")} ${alternatives.length === 1 ? "is" : "are"} open now.`
            : `The other slots are full too — try again shortly.`),
      },
    };
  }

  const quote = quoteForQueue(slot, durationH, queuedHours);

  return {
    ok: true,
    quote: {
      slot,
      durationH,
      multiplierCm: quote.multiplierCm,
      askHrCents: quote.askHrCents,
      totalCents: quote.totalCents,
      waitHours,
      queuedHours,
      queuedAhead,
      immediate: waitHours === 0,
    },
  };
}

/**
 * Starts a Stripe Checkout session (#26).
 *
 * The price is computed here and locked into the session metadata. Between now
 * and the webhook the queue may move; the buyer pays what they were quoted, and
 * the webhook writes that figure rather than recomputing it.
 *
 * No purchase row is created. That happens only when payment clears.
 */
export async function startPayment(input: unknown): Promise<StartPaymentResult> {
  const priced = await priceCheckout(input);
  if (!priced.ok) return priced;

  if (!stripeConfigured()) {
    return {
      ok: false,
      errors: {
        form:
          "Payments are not configured in this environment. The listing validated and " +
          "priced correctly; set real Stripe keys to take payment.",
      },
    };
  }

  const parsed = parseCheckout(input);
  if (!parsed.success) return { ok: false, errors: fieldErrors(parsed.error) };

  const { quote } = priced;
  const { APP_URL } = serverConfig();

  const session = await liveGateway.createCheckoutSession({
    totalCents: quote.totalCents,
    description: `TopNow slot ${String(quote.slot).padStart(2, "0")} — ${quote.durationH}h`,
    successUrl: `${APP_URL}/?paid=1`,
    cancelUrl: `${APP_URL}/checkout`,
    metadata: {
      slot: String(quote.slot),
      durationH: String(quote.durationH),
      handle: parsed.data.handle,
      platform: parsed.data.platform,
      displayName: parsed.data.displayName ?? "",
      targetUrl: parsed.data.targetUrl,
      tagline: parsed.data.tagline,
      // Locked. The webhook writes these rather than re-pricing.
      priceHrCents: String(quote.askHrCents),
      totalPaidCents: String(quote.totalCents),
    },
  });

  if (!session.url) {
    return { ok: false, errors: { form: "Stripe did not return a checkout URL." } };
  }
  return { ok: true, url: session.url };
}
