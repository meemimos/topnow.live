import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { QUEUE_CAP_HOURS, quoteForQueue } from "@/lib/pricing";
import { liveOnSlot } from "@/lib/purchase/state";

import type { PaymentGateway } from "./stripe";
import { InvalidSessionMetadataError, handleStripeEvent, parseSessionMetadata } from "./webhook";

/**
 * The payment path (#26), tested end to end without a Stripe credential.
 *
 * Payloads are signed with Stripe's own `generateTestHeaderString`, and verified
 * with Stripe's own `constructEvent`, so what is under test is the code that
 * actually runs in production rather than a reimplementation of HMAC.
 */

const db = getDb();
const SECRET = "whsec_placeholder_not_a_real_secret";
const NOW = new Date("2026-09-01T12:00:00.000Z");

function metadataFor(slot: 1 | 2 | 3, durationH: 1 | 3 | 6 | 12 | 24, handle: string) {
  const q = quoteForQueue(slot, durationH, 0);
  return {
    slot: String(slot),
    durationH: String(durationH),
    handle,
    platform: "github",
    displayName: "",
    targetUrl: `https://github.com/${handle}`,
    tagline: "A tagline.",
    priceHrCents: String(q.askHrCents),
    totalPaidCents: String(q.totalCents),
  };
}

function completedSessionEvent(
  sessionId: string,
  metadata: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `evt_${sessionId}`,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: `pi_${sessionId}`,
        metadata,
        ...overrides,
      },
    },
  };
}

/** Signs a payload exactly as Stripe does, using Stripe's own helper. */
function sign(payload: string, timestamp = Math.floor(NOW.getTime() / 1000)) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp });
}

function fakeGateway() {
  return {
    createCheckoutSession: vi.fn(),
    refund: vi.fn().mockResolvedValue({ id: "re_test" }),
  } satisfies PaymentGateway as PaymentGateway & { refund: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  await db.purchase.deleteMany();
});

afterAll(async () => {
  await db.purchase.deleteMany();
  await db.$disconnect();
});

describe("signature verification", () => {
  it("accepts a correctly signed payload", () => {
    const payload = JSON.stringify(completedSessionEvent("cs_ok", metadataFor(1, 3, "mira")));
    const event = Stripe.webhooks.constructEvent(payload, sign(payload), SECRET);
    expect(event.type).toBe("checkout.session.completed");
  });

  // An unverified endpoint is an unauthenticated write to the purchases table.
  it("rejects a payload signed with the wrong secret", () => {
    const payload = JSON.stringify(completedSessionEvent("cs_bad", metadataFor(1, 3, "mira")));
    const wrong = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_someone_elses_secret",
    });
    expect(() => Stripe.webhooks.constructEvent(payload, wrong, SECRET)).toThrow();
  });

  it("rejects a payload altered after signing", () => {
    const payload = JSON.stringify(completedSessionEvent("cs_tamper", metadataFor(1, 3, "mira")));
    const header = sign(payload);
    const tampered = payload.replace('"cs_tamper"', '"cs_attacker"');
    expect(() => Stripe.webhooks.constructEvent(tampered, header, SECRET)).toThrow();
  });

  it("rejects a missing signature header", () => {
    const payload = JSON.stringify(completedSessionEvent("cs_none", metadataFor(1, 3, "mira")));
    expect(() => Stripe.webhooks.constructEvent(payload, "", SECRET)).toThrow();
  });

  /**
   * Replay protection. Stripe's default tolerance is 300 seconds and
   * `constructEvent` applies it — worth knowing that the lower-level
   * `verifyHeader` defaults tolerance to 0, which skips this check entirely.
   */
  it("rejects a signature captured outside the tolerance window", () => {
    const payload = JSON.stringify(completedSessionEvent("cs_old", metadataFor(1, 3, "mira")));
    const longAgo = Math.floor(Date.now() / 1000) - 60 * 60;
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: SECRET,
      timestamp: longAgo,
    });

    expect(() => Stripe.webhooks.constructEvent(payload, header, SECRET)).toThrowError(
      /Timestamp outside the tolerance zone/,
    );
  });

  // Stripe signs the exact bytes it sent, so a parsed-and-restringified body
  // will not verify. The SDK says so specifically.
  it("rejects a body that was parsed and re-serialised", () => {
    const event = completedSessionEvent("cs_reparsed", metadataFor(1, 3, "mira"));
    const original = JSON.stringify(event);
    const header = sign(original);
    const roundTripped = JSON.stringify(JSON.parse(original), null, 2);

    expect(() => Stripe.webhooks.constructEvent(roundTripped, header, SECRET)).toThrow();
  });
});

describe("a purchase exists only once payment clears", () => {
  it("creates a queued purchase from a paid session", async () => {
    const event = completedSessionEvent("cs_paid", metadataFor(1, 3, "mira"));
    const outcome = await handleStripeEvent(event as never, fakeGateway(), NOW);

    expect(outcome).toMatchObject({ kind: "created" });
    const stored = await db.purchase.findFirstOrThrow({ where: { stripeSessionId: "cs_paid" } });
    expect(stored.handle).toBe("mira");
  });

  /**
   * An abandoned checkout must not hold a queue position or move surge —
   * both would be fabricated signals.
   */
  it("creates nothing for an expired session", async () => {
    const event = {
      id: "evt_exp",
      type: "checkout.session.expired",
      data: { object: { id: "cs_exp", metadata: metadataFor(1, 3, "ghost") } },
    };
    const outcome = await handleStripeEvent(event as never, fakeGateway(), NOW);

    expect(outcome).toMatchObject({ kind: "ignored" });
    expect(await db.purchase.count()).toBe(0);
  });

  it("creates nothing for a failed payment", async () => {
    const event = { id: "evt_fail", type: "payment_intent.payment_failed", data: { object: {} } };
    expect(await handleStripeEvent(event as never, fakeGateway(), NOW)).toMatchObject({
      kind: "ignored",
    });
    expect(await db.purchase.count()).toBe(0);
  });

  // Stripe sends completed sessions that are not paid for async payment methods.
  it("creates nothing for a completed but unpaid session", async () => {
    const event = completedSessionEvent("cs_unpaid", metadataFor(1, 3, "later"), {
      payment_status: "unpaid",
    });
    expect(await handleStripeEvent(event as never, fakeGateway(), NOW)).toMatchObject({
      kind: "ignored",
    });
    expect(await db.purchase.count()).toBe(0);
  });

  it("goes live immediately when the slot is free", async () => {
    const event = completedSessionEvent("cs_live", metadataFor(2, 3, "firstin"));
    await handleStripeEvent(event as never, fakeGateway(), NOW);

    expect((await liveOnSlot(2, NOW))?.handle).toBe("firstin");
  });
});

describe("idempotency", () => {
  // Stripe retries. Guaranteed by the unique constraint on stripeSessionId
  // (#21), not by checking first — checking first would still race.
  it("creates one row for a redelivered event", async () => {
    const event = completedSessionEvent("cs_retry", metadataFor(1, 3, "mira"));

    const first = await handleStripeEvent(event as never, fakeGateway(), NOW);
    const second = await handleStripeEvent(event as never, fakeGateway(), NOW);

    expect(first).toMatchObject({ kind: "created" });
    expect(second).toMatchObject({ kind: "duplicate" });
    expect(await db.purchase.count({ where: { stripeSessionId: "cs_retry" } })).toBe(1);
  });

  it("creates one row when two deliveries land together", async () => {
    const event = completedSessionEvent("cs_race", metadataFor(1, 3, "mira"));

    const results = await Promise.allSettled([
      handleStripeEvent(event as never, fakeGateway(), NOW),
      handleStripeEvent(event as never, fakeGateway(), NOW),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await db.purchase.count({ where: { stripeSessionId: "cs_race" } })).toBe(1);
  });
});

describe("the price is the one that was quoted", () => {
  /**
   * The locked-price guarantee, enforced where it actually matters. Surge moves
   * between quote and payment; the buyer pays what they were shown.
   */
  it("writes the locked metadata rather than re-pricing at webhook time", async () => {
    // Quoted at base.
    const metadata = metadataFor(1, 3, "earlybird");

    // The queue fills before the webhook arrives, so live surge is now higher.
    for (let i = 0; i < 3; i += 1) {
      const q = quoteForQueue(1, 6, 0);
      await db.purchase.create({
        data: {
          slot: 1,
          durationH: 6,
          handle: `filler${i}`,
          platform: "github",
          targetUrl: `https://github.com/filler${i}`,
          tagline: "t",
          priceHrCents: q.askHrCents,
          totalPaidCents: q.totalCents,
          status: "queued",
        },
      });
    }

    await handleStripeEvent(
      completedSessionEvent("cs_locked", metadata) as never,
      fakeGateway(),
      NOW,
    );

    const stored = await db.purchase.findFirstOrThrow({ where: { stripeSessionId: "cs_locked" } });
    expect(stored.priceHrCents).toBe(Number(metadata.priceHrCents));
    expect(stored.totalPaidCents).toBe(Number(metadata.totalPaidCents));
  });
});

describe("the cap race", () => {
  /**
   * The cap check at quote time is advisory: between quote and payment the queue
   * can fill. Taking money for a position that cannot exist is worse than a
   * refund, so this refunds rather than queues.
   */
  it("refunds rather than queueing when the slot filled in the meantime", async () => {
    // Push the wait past the cap while the buyer was paying.
    for (let i = 0; i < 6; i += 1) {
      const q = quoteForQueue(3, 6, 0);
      await db.purchase.create({
        data: {
          slot: 3,
          durationH: 6,
          handle: `rush${i}`,
          platform: "github",
          targetUrl: `https://github.com/rush${i}`,
          tagline: "t",
          priceHrCents: q.askHrCents,
          totalPaidCents: q.totalCents,
          status: "queued",
        },
      });
    }

    const gateway = fakeGateway();
    const outcome = await handleStripeEvent(
      completedSessionEvent("cs_toolate", metadataFor(3, 3, "toolate")) as never,
      gateway,
      NOW,
    );

    expect(outcome).toMatchObject({ kind: "refunded" });
    expect(gateway.refund).toHaveBeenCalledWith("pi_cs_toolate", expect.stringContaining("slot"));
    expect(await db.purchase.count({ where: { stripeSessionId: "cs_toolate" } })).toBe(0);
  });
});

describe("session metadata is validated, not trusted", () => {
  it("accepts well-formed metadata", () => {
    expect(parseSessionMetadata(metadataFor(1, 3, "mira")).slot).toBe(1);
  });

  it.each([
    ["no metadata", null],
    ["a bad slot", { ...metadataFor(1, 3, "m"), slot: "9" }],
    ["a non-snap duration", { ...metadataFor(1, 3, "m"), durationH: "5" }],
    ["a zero price", { ...metadataFor(1, 3, "m"), priceHrCents: "0" }],
    ["an unknown platform", { ...metadataFor(1, 3, "m"), platform: "myspace" }],
    ["a non-https target", { ...metadataFor(1, 3, "m"), targetUrl: "http://x.dev" }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSessionMetadata(raw as never)).toThrow(InvalidSessionMetadataError);
  });

  // A total that disagrees with rate times hours would violate #21's check
  // constraint anyway; refusing here says why rather than surfacing a database
  // error.
  it("rejects a total that disagrees with rate times hours", () => {
    expect(() =>
      parseSessionMetadata({ ...metadataFor(1, 3, "m"), totalPaidCents: "1" } as never),
    ).toThrowError(/does not match/);
  });

  it("never writes a row from unusable metadata", async () => {
    const bad = { ...metadataFor(1, 3, "m"), durationH: "5" };
    await expect(
      handleStripeEvent(completedSessionEvent("cs_bad_meta", bad) as never, fakeGateway(), NOW),
    ).rejects.toThrow(InvalidSessionMetadataError);
    expect(await db.purchase.count()).toBe(0);
  });
});

describe("the cap constant is shared", () => {
  it("uses the same cap the quote used", () => {
    expect(QUEUE_CAP_HOURS).toBe(24);
  });
});
