import "server-only";

import Stripe from "stripe";

import { serverConfig, stripeConfigured } from "@/lib/config/server";

/**
 * The one place that talks to Stripe (#26).
 *
 * Everything else goes through `PaymentGateway` below, so the webhook handler,
 * the cap re-check and the refund path can all be tested against a substitute
 * without a credential and without network access.
 *
 * Signature verification is deliberately NOT abstracted: it uses Stripe's own
 * `constructEvent`, and the tests sign their payloads with Stripe's own
 * `generateTestHeaderString`. Reimplementing HMAC here would mean testing my
 * reimplementation rather than the thing that runs in production.
 */

let client: Stripe | undefined;

export function stripe(): Stripe {
  if (!stripeConfigured()) {
    throw new StripeNotConfiguredError();
  }
  client ??= new Stripe(serverConfig().STRIPE_SECRET_KEY);
  return client;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      "Stripe is running on placeholder keys. Set STRIPE_SECRET_KEY and " +
        "STRIPE_WEBHOOK_SECRET to real values to talk to Stripe.",
    );
    this.name = "StripeNotConfiguredError";
  }
}

/**
 * Verifies and parses a webhook.
 *
 * `payload` must be the raw request body. Stripe signs the exact bytes it sent,
 * so a parsed-and-restringified object will not verify — the SDK raises a
 * specific error saying as much.
 *
 * The tolerance is Stripe's own default (300 seconds), which `constructEvent`
 * applies. Worth knowing: the lower-level `verifyHeader` defaults tolerance to
 * 0, which *skips* the replay check entirely, so calling that directly would
 * silently accept a signature captured days ago.
 */
export function constructWebhookEvent(payload: string, signature: string): Stripe.Event {
  const { STRIPE_WEBHOOK_SECRET } = serverConfig();
  return Stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
}

/** What the app needs from Stripe. Substituted wholesale in tests. */
export type PaymentGateway = {
  createCheckoutSession(input: CreateSessionInput): Promise<{ id: string; url: string | null }>;
  refund(paymentIntentId: string, reason: string): Promise<{ id: string }>;
};

export type CreateSessionInput = {
  totalCents: number;
  /** Echoed back on the webhook. The price is locked here, not recomputed later. */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  description: string;
};

export const liveGateway: PaymentGateway = {
  async createCheckoutSession(input) {
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: input.totalCents,
            product_data: { name: input.description },
          },
        },
      ],
      metadata: input.metadata,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    return { id: session.id, url: session.url };
  },

  async refund(paymentIntentId, reason) {
    const refund = await stripe().refunds.create({
      payment_intent: paymentIntentId,
      // Stripe's own vocabulary; the human reason goes in metadata.
      reason: "requested_by_customer",
      metadata: { topnow_reason: reason },
    });
    return { id: refund.id };
  },
};
