import { expect, test } from "@playwright/test";
import Stripe from "stripe";

/**
 * Stripe's webhook endpoint (#26).
 *
 * An unverified webhook is an unauthenticated write to the purchases table, so
 * what is tested here is the boundary: which requests the deployed route lets
 * past verification at all. Everything after verification — idempotency, the
 * locked price, the capacity re-check and its refund — is covered by unit tests
 * against a real database, and none of these requests reach it.
 *
 * The signatures are generated with Stripe's own `generateTestHeaderString`
 * rather than hand-rolled HMAC, so the test agrees with the SDK by construction
 * instead of by my reading of the scheme.
 */

const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function body(type: string) {
  return JSON.stringify({
    id: "evt_e2e",
    object: "event",
    type,
    data: { object: { id: "pi_e2e", object: "payment_intent" } },
  });
}

function sign(
  payload: string,
  { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

async function post(
  request: import("@playwright/test").APIRequestContext,
  payload: string,
  signature?: string,
) {
  return request.post("/api/stripe/webhook", {
    headers: {
      "content-type": "application/json",
      ...(signature ? { "stripe-signature": signature } : {}),
    },
    data: payload,
  });
}

test("refuses a webhook with no signature", async ({ request }) => {
  const response = await post(request, body("payment_intent.created"));
  expect(response.status()).toBe(400);
});

test("refuses a malformed signature header", async ({ request }) => {
  const response = await post(request, body("payment_intent.created"), "not-a-signature");
  expect(response.status()).toBe(400);
});

test("refuses a signature made with the wrong secret", async ({ request }) => {
  const payload = body("payment_intent.created");
  const response = await post(request, payload, sign(payload, { secret: "whsec_someone_elses" }));
  expect(response.status()).toBe(400);
});

test("refuses a body altered after signing", async ({ request }) => {
  const payload = body("payment_intent.created");
  const signature = sign(payload);
  const response = await post(request, payload.replace("pi_e2e", "pi_swapped"), signature);
  expect(response.status()).toBe(400);
});

test("refuses a captured signature replayed past the tolerance", async ({ request }) => {
  // Stripe's default tolerance is 300 seconds. An hour old is well outside it,
  // so a signature scraped from a log cannot be resent later.
  const payload = body("payment_intent.created");
  const stale = Math.floor(Date.now() / 1000) - 3_600;
  const response = await post(request, payload, sign(payload, { timestamp: stale }));
  expect(response.status()).toBe(400);
});

test("accepts a correctly signed event and ignores the ones it does not handle", async ({
  request,
}) => {
  // The positive control: without it, every test above would still pass if the
  // route simply rejected everything. `payment_intent.created` verifies and is
  // then deliberately ignored, so nothing is written.
  const payload = body("payment_intent.created");
  const response = await post(request, payload, sign(payload));
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ received: true, outcome: "ignored" });
});
