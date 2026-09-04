import type { AskSample, Purchase } from "@prisma/client";

import { formatMultiplier } from "@/lib/pricing/format";
import { sampleToMultiplierCm } from "@/lib/market/ask";

/**
 * The activity ticker (#16).
 *
 * Every item here is **derived from a row that already exists**. There is no
 * events table, nothing writes to one, and therefore nothing to seed — which is
 * the point. A ticker with its own table is a ticker somebody can fill on a
 * quiet afternoon, and the build prompt's one non-negotiable is that no activity
 * is ever fabricated.
 *
 * What that buys, concretely: a quiet board produces a quiet ticker. There is no
 * welcome message, no rotating tip, no replayed history dressed as live
 * activity, and no synthetic heartbeat to keep the strip moving. When nothing
 * has happened, the honest output is the last real thing that did — or nothing.
 */

export type TickerKind = "live" | "ended" | "queued" | "surge" | "base";

export type TickerEvent = {
  kind: TickerKind;
  /** When it actually happened. Every item carries one; none is approximate. */
  at: Date;
  slot: number;
  /** Untrusted user content. Rendered as text, never interpolated into markup. */
  handle: string | null;
  /** The multiplier at the moment, in hundredths, for the two price events. */
  multiplierCm: number | null;
};

/** Most recent first, and never more than the strip can honestly hold. */
export const MAX_EVENTS = 12;

/**
 * Purchase transitions.
 *
 * Three of them, each read off a timestamp the row already carries rather than
 * from `status`. A rental whose window has closed has ended whether or not any
 * process noticed (#1), so the ticker says so on the same evidence the board
 * uses — otherwise the two surfaces could disagree about what has happened.
 */
export function purchaseEvents(purchases: readonly Purchase[], now: Date): TickerEvent[] {
  const events: TickerEvent[] = [];

  for (const purchase of purchases) {
    events.push({
      kind: "queued",
      at: purchase.boughtAt,
      slot: purchase.slot,
      handle: purchase.handle || null,
      multiplierCm: null,
    });

    if (purchase.startsAt && purchase.startsAt <= now) {
      events.push({
        kind: "live",
        at: purchase.startsAt,
        slot: purchase.slot,
        handle: purchase.handle || null,
        multiplierCm: null,
      });
    }

    // Derived from the window, not from `status`. A killed listing (#17) also
    // frees its slot, and `endsAt` is what says when.
    if (purchase.endsAt && purchase.endsAt <= now) {
      events.push({
        kind: "ended",
        at: purchase.endsAt,
        slot: purchase.slot,
        handle: purchase.handle || null,
        multiplierCm: null,
      });
    }
  }

  return events;
}

/**
 * Price transitions, from the hourly samples (#22).
 *
 * An event is emitted only where two consecutive samples on a slot actually
 * differ — a slot sitting at the same multiplier for a day produces nothing,
 * which is the correct amount of activity for a slot that has not moved.
 *
 * The first sample on a slot is never an event: there is no previous
 * observation, so there is no change to report. Calling it "moved to base" would
 * be inventing a transition out of the start of the record.
 */
export function priceEvents(samples: readonly AskSample[]): TickerEvent[] {
  const bySlot = new Map<number, AskSample[]>();
  for (const sample of samples) {
    const list = bySlot.get(sample.slot);
    if (list) list.push(sample);
    else bySlot.set(sample.slot, [sample]);
  }

  const events: TickerEvent[] = [];

  for (const [slot, list] of bySlot) {
    const ordered = [...list].sort((a, b) => a.hour.getTime() - b.hour.getTime());

    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!;
      const current = ordered[index]!;

      const was = sampleToMultiplierCm(previous);
      const is = sampleToMultiplierCm(current);
      if (was === is) continue;

      events.push({
        // Returning to base is its own event because it is the one the board is
        // about: the slot is available again at the price on the tin.
        kind: current.askHrCents === current.baseHrCents ? "base" : "surge",
        at: current.hour,
        slot,
        handle: null,
        multiplierCm: is,
      });
    }
  }

  return events;
}

/**
 * The strip, newest first.
 *
 * Ties are broken by how far along a purchase's life each event sits, ordered the
 * same way the timestamps are: latest first. A listing bought onto a free slot
 * goes live in the same instant, and the strip reads "went live · joined the
 * queue" — reverse chronological, exactly like every non-simultaneous pair
 * beside it. Sorting them the other way would put one pair in the strip running
 * forwards while everything around it ran backwards.
 */
const KIND_ORDER: Record<TickerKind, number> = {
  queued: 0,
  live: 1,
  surge: 2,
  base: 3,
  ended: 4,
};

export function buildTicker(
  purchases: readonly Purchase[],
  samples: readonly AskSample[],
  now: Date,
  limit = MAX_EVENTS,
): TickerEvent[] {
  return [...purchaseEvents(purchases, now), ...priceEvents(samples)]
    .filter((event) => event.at <= now)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || KIND_ORDER[b.kind] - KIND_ORDER[a.kind])
    .slice(0, limit);
}

/** The slot as it is written everywhere else on the board. */
function slotName(slot: number): string {
  return `slot ${String(slot).padStart(2, "0")}`;
}

/**
 * One event as a sentence.
 *
 * The handle is returned separately from the surrounding words rather than
 * concatenated into them, so the component can render it as its own text node.
 * It is user content, and keeping it a value rather than part of a string is
 * what stops it ever being treated as anything else.
 */
export function describe(event: TickerEvent): {
  before: string;
  handle: string | null;
  after: string;
} {
  switch (event.kind) {
    case "queued":
      return {
        before: "",
        handle: handleText(event),
        after: ` joined the queue for ${slotName(event.slot)}`,
      };
    case "live":
      return {
        before: "",
        handle: handleText(event),
        after: ` went live on ${slotName(event.slot)}`,
      };
    case "ended":
      return {
        before: "",
        handle: handleText(event),
        after: ` ended — ${slotName(event.slot)} reopened`,
      };
    case "surge":
      return {
        before: `${slotName(event.slot)} moved to `,
        handle: null,
        after: `${formatMultiplier(event.multiplierCm ?? 0)}× base`,
      };
    case "base":
      return { before: "", handle: null, after: `${slotName(event.slot)} back to base` };
  }
}

function handleText(event: TickerEvent): string | null {
  if (!event.handle) return null;
  return `@${event.handle}`;
}

/**
 * What the strip says when there is nothing in it.
 *
 * Not a greeting and not a placeholder event: a statement of fact about a board
 * that has not been bought yet. On launch day this is the truth, and saying it
 * plainly is better than inventing motion to cover for it.
 */
export const NOTHING_YET = "Nothing has happened on the board yet.";
