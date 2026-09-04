import "server-only";

import { Prisma } from "@prisma/client";
import type Stripe from "stripe";

import type { Platform } from "@prisma/client";

import { ensureAvatar } from "@/lib/avatar/store";
import { isValidPostUrl } from "@/lib/embed/providers";
import { ensureEmbed } from "@/lib/embed/store";
import { isDurationHours, isSlot, type DurationHours, type Slot } from "@/lib/pricing";
import {
  QueueAtCapacityError,
  acceptsNewBookings,
  inSerializableTransaction,
  waitHoursForSlot,
} from "@/lib/purchase/queue";
import { promoteSlot } from "@/lib/purchase/state";

import type { PaymentGateway } from "./stripe";

/**
 * Turning a paid Stripe session into a purchase (#26).
 *
 * The central rule: **a purchase row is created only when payment has cleared,
 * and this is what creates it.** Creating it at checkout-start and marking it
 * paid later would mean an abandoned checkout holds a queue position, moves
 * surge, and shows up in the ledger — every one of those a fabricated signal.
 */

/** Everything needed to build the purchase, carried on the session. */
export type SessionMetadata = {
  slot: Slot;
  durationH: DurationHours;
  handle: string;
  platform: "github" | "youtube" | "instagram" | "tiktok" | "reddit" | "web";
  displayName: string | null;
  targetUrl: string;
  /** The post to embed on slot 01 (#20). Null for a listing without one. */
  postUrl: string | null;
  tagline: string;
  /** Locked at checkout. Never recomputed here. */
  priceHrCents: number;
  totalPaidCents: number;
};

const PLATFORMS = ["github", "youtube", "instagram", "tiktok", "reddit", "web"] as const;

export class InvalidSessionMetadataError extends Error {
  constructor(reason: string) {
    super(`Checkout session metadata is unusable: ${reason}`);
    this.name = "InvalidSessionMetadataError";
  }
}

/**
 * Reads the metadata back off the session.
 *
 * Validated rather than trusted. Stripe echoes back whatever was sent, but a
 * session could have been created by an older deploy with a different shape,
 * and a malformed row is worse than a refused one.
 */
export function parseSessionMetadata(raw: Record<string, string> | null): SessionMetadata {
  if (!raw) throw new InvalidSessionMetadataError("no metadata present");

  const slot = Number(raw.slot);
  const durationH = Number(raw.durationH);
  const priceHrCents = Number(raw.priceHrCents);
  const totalPaidCents = Number(raw.totalPaidCents);

  if (!isSlot(slot)) throw new InvalidSessionMetadataError(`slot ${raw.slot}`);
  if (!isDurationHours(durationH))
    throw new InvalidSessionMetadataError(`duration ${raw.durationH}`);
  if (!Number.isInteger(priceHrCents) || priceHrCents <= 0) {
    throw new InvalidSessionMetadataError(`priceHrCents ${raw.priceHrCents}`);
  }
  if (totalPaidCents !== priceHrCents * durationH) {
    throw new InvalidSessionMetadataError("total does not match rate times hours");
  }
  if (!PLATFORMS.includes(raw.platform as (typeof PLATFORMS)[number])) {
    throw new InvalidSessionMetadataError(`platform ${raw.platform}`);
  }
  if (!raw.targetUrl?.startsWith("https://")) {
    throw new InvalidSessionMetadataError("targetUrl is not https");
  }
  // Re-validated rather than trusted, like everything else here: the session
  // could have been created by an older deploy with looser rules, and this URL
  // is what an outbound request will later be built from.
  if (raw.postUrl && !isValidPostUrl(raw.platform as Platform, raw.postUrl)) {
    throw new InvalidSessionMetadataError("postUrl is not a usable post link");
  }

  return {
    slot,
    durationH,
    handle: raw.handle ?? "",
    platform: raw.platform as SessionMetadata["platform"],
    displayName: raw.displayName || null,
    targetUrl: raw.targetUrl,
    postUrl: raw.postUrl || null,
    tagline: raw.tagline ?? "",
    priceHrCents,
    totalPaidCents,
  };
}

export type WebhookOutcome =
  | { kind: "created"; purchaseId: string; media: PendingMedia }
  | { kind: "duplicate" }
  | { kind: "refunded"; reason: string }
  | { kind: "ignored"; type: string };

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Handles one verified webhook event.
 *
 * Idempotent by constraint: `stripeSessionId` is unique (#21), so a retried or
 * concurrently-delivered event produces one row, not two. Checking first would
 * still race.
 *
 * Ordering-independent: nothing here assumes events arrive in the order Stripe
 * sent them.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  gateway: PaymentGateway,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCompletedSession(event.data.object as Stripe.Checkout.Session, gateway, now);

    // A failed payment leaves no queue position, because no row was ever made.
    // Recorded here so the reason for doing nothing is explicit rather than a
    // silent fallthrough.
    case "checkout.session.expired":
    case "payment_intent.payment_failed":
    case "charge.dispute.created":
      return { kind: "ignored", type: event.type };

    default:
      return { kind: "ignored", type: event.type };
  }
}

/** What a created purchase still needs fetched from a third party. */
export type PendingMedia = {
  platform: SessionMetadata["platform"];
  handle: string;
  postUrl: string | null;
  now: Date;
};

/**
 * Fetch the listing's avatar and post embed (#19, #20).
 *
 * Exported and called by the route rather than from inside the handler, because
 * the scheduling primitive (`after`) belongs to the request lifecycle and this
 * module has no business knowing about one. It also keeps this directly
 * callable from a test.
 *
 * Neither call can throw — both report failure as a return value — and neither
 * is load-bearing: a listing whose avatar did not resolve renders the designed
 * placeholder, and one whose embed did not resolve renders the profile card.
 * Whatever does not land here is picked up by the hourly refresh.
 */
export async function resolveListingMedia(media: PendingMedia): Promise<void> {
  await ensureAvatar(media.platform, media.handle, { now: media.now });
  if (media.postUrl) {
    await ensureEmbed(media.platform, media.postUrl, { now: media.now });
  }
}

async function handleCompletedSession(
  session: Stripe.Checkout.Session,
  gateway: PaymentGateway,
  now: Date,
): Promise<WebhookOutcome> {
  // Stripe sends completed sessions that are not paid (async payment methods).
  // A purchase exists only once money has actually cleared.
  if (session.payment_status !== "paid") {
    return { kind: "ignored", type: `unpaid:${session.payment_status}` };
  }

  const metadata = parseSessionMetadata(session.metadata);

  try {
    const purchase = await inSerializableTransaction(async (tx) => {
      // The cap check at quote time was advisory: between quote and payment the
      // queue can fill. Re-checked here, inside the transaction that creates the
      // row, because two buyers can both have seen room.
      const wait = await waitHoursForSlot(tx, metadata.slot, now);
      if (!acceptsNewBookings(wait)) {
        throw new QueueAtCapacityError(metadata.slot, wait, metadata.durationH);
      }

      return tx.purchase.create({
        data: {
          slot: metadata.slot,
          durationH: metadata.durationH,
          handle: metadata.handle,
          platform: metadata.platform,
          displayName: metadata.displayName,
          targetUrl: metadata.targetUrl,
          postUrl: metadata.postUrl,
          tagline: metadata.tagline,
          // Straight from the locked metadata. Recomputing here would re-price
          // the buyer at whatever surge has since become.
          priceHrCents: metadata.priceHrCents,
          totalPaidCents: metadata.totalPaidCents,
          status: "queued",
          stripeSessionId: session.id,
        },
      });
    });

    // The slot may be free right now, in which case this listing goes live
    // immediately rather than waiting for a read or the hourly job.
    await promoteSlot(metadata.slot, now);

    // Resolve the avatar and the embed here, because this is the submit (#19,
    // #20): it is the one moment the product learns about a new account, and
    // resolving anywhere downstream would mean resolving on a read.
    //
    // Deferred rather than awaited inline. Both calls talk to third parties —
    // up to four seconds for an avatar and seven for an embed and its
    // thumbnail — and Stripe's handler has to answer quickly. Awaited, a slow
    // provider could hold the response past the function's limit, killing the
    // handler *after* the purchase committed but *before* the 200: Stripe would
    // record a failed delivery and retry a purchase that already exists.
    //
    // A bare dangling promise would be the other failure — the runtime can kill
    // it the instant the handler returns. `after` is the primitive for exactly
    // this: the work runs once the response is sent, still inside the
    // invocation's lifetime.
    return {
      kind: "created",
      purchaseId: purchase.id,
      // Handed back rather than fetched here. Both calls talk to third parties
      // — up to four seconds for an avatar and seven for an embed and its
      // thumbnail — and Stripe's handler has to answer quickly. Awaited inline,
      // a slow provider could hold the response past the function's limit,
      // killing the handler *after* the purchase committed but *before* the
      // 200: Stripe would record a failed delivery and retry a purchase that
      // already exists. The route runs this after the response has gone.
      media: {
        platform: metadata.platform,
        handle: metadata.handle,
        postUrl: metadata.postUrl,
        now,
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Stripe retried, or two deliveries landed together. One row exists,
      // which is the correct outcome.
      return { kind: "duplicate" };
    }

    if (error instanceof QueueAtCapacityError) {
      // Taking money for a position that cannot exist is worse than a refund.
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;

      if (paymentIntentId) {
        await gateway.refund(paymentIntentId, "slot filled between checkout and payment");
      }
      return { kind: "refunded", reason: error.message };
    }

    throw error;
  }
}
