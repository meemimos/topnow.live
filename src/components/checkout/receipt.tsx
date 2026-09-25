"use client";

import Link from "next/link";

import type { CheckoutQuote } from "@/app/actions/checkout";
import { QueuePosition } from "@/components/checkout/queue-position";
import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { quote as buildQuote } from "@/lib/pricing";
import {
  actionLabel,
  derivation,
  formatMoney,
  formatMultiplier,
  hasSurge,
  lineItem,
  slotLabel,
} from "@/lib/pricing/format";
import { ordinal } from "@/lib/time";

/**
 * The receipt (#9).
 *
 * Every figure comes from one call to the pricing engine, so the line item, the
 * derivation beneath it, the total and the button label cannot disagree. That
 * is also why the engine quantises multipliers before pricing anything (#2):
 * the three numbers printed here multiply out to exactly the printed total, so
 * a buyer can check the arithmetic rather than take it on trust.
 *
 * A premium is expressed as a multiplier, never as a colour — nothing in this
 * panel is red or green.
 */
export function Receipt({
  quote,
  onTake,
  pending,
}: {
  quote: CheckoutQuote;
  onTake?: () => void;
  pending?: boolean;
}) {
  // Rebuilt from the locked multiplier rather than re-derived from the queue:
  // this is the quote the buyer was given, and it does not move under them.
  const priced = buildQuote(quote.slot, quote.durationH, quote.multiplierCm);

  return (
    <div>
      <Plate variant="inset" surface="paper" className="p-3">
        <div className="text-xs mb-2 flex items-center justify-between gap-2 border-b-2 border-dashed border-ink-soft pb-2 font-pixel">
          <span className="font-bold tracking-[0.04em]">TOPNOW RECEIPT</span>
          <span className="text-ink-soft">NOT YET PAID</span>
        </div>

        <div className="text-md flex items-center justify-between gap-2">
          <span className="font-pixel">SLOT</span>
          <span className="font-pixel font-bold">{slotLabel(quote.slot)}</span>
        </div>

        <div className="my-2 border-b-2 border-dashed border-ink-soft" />

        <div className="flex items-baseline justify-between gap-2">
          {/* The effective rate — what is actually being charged per hour. */}
          <span className="text-md font-pixel">{lineItem(priced)}</span>
          <span className="text-md font-pixel" data-numeric>
            {formatMoney(priced.totalCents)}
          </span>
        </div>
        {/* The derivation, so the total can be checked rather than trusted. */}
        <div className="text-xs mt-1 font-pixel text-ink-soft" data-numeric>
          {derivation(priced)}
        </div>

        <div className="my-2 border-b-2 border-dashed border-ink-soft" />

        <div className="text-md flex items-center justify-between gap-2">
          <span className="font-pixel">STARTS</span>
          <span className="font-pixel font-bold">
            {quote.immediate
              ? "IMMEDIATELY"
              : `${ordinal(quote.queuedAhead + 1).toUpperCase()} IN LINE`}
          </span>
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-2 border-t border-ink pt-2">
          <span className="text-lg font-pixel font-bold">TOTAL</span>
          <span className="text-3xl font-pixel font-bold" data-numeric>
            {formatMoney(priced.totalCents)}
          </span>
        </div>
      </Plate>

      {/* Only when there is something to say. Surge is a multiplier here, not a
          colour, and not a red badge. */}
      {hasSurge(quote.multiplierCm) && (
        <div className="text-md mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1.5 border border-ink bg-ink px-3 py-2.5 text-paper">
          {/* A black plate with a badge, as the prototype has it. Urgency here
              comes from weight, size and the plate — never from red, which
              means price direction on the chart and nothing anywhere else. */}
          <span className="text-2xs shrink-0 border border-paper px-1.5 py-0.5 font-pixel font-bold">
            SURGE {formatMultiplier(quote.multiplierCm)}×
          </span>
          <span className="flex-1 leading-[1.6]">
            {quote.queuedHours}h are queued on this slot, which is what lifts the rate above base.
            Your rate is locked at checkout and will not move afterwards.
          </span>
        </div>
      )}

      <Plate surface="note" className="text-md mt-2 border-2 px-3 py-2 shadow-none">
        <QueuePosition quote={quote} />
      </Plate>

      {/* The button states what happens, never "Continue" or "Pay". */}
      <BevelButton variant="navy" size="lg" className="mt-3" disabled={pending} onClick={onTake}>
        {pending ? "STARTING…" : actionLabel(priced, !quote.immediate)}
      </BevelButton>

      <p className="text-md mt-2 mb-0 leading-[1.6] text-ink-soft">
        The meter starts the moment payment clears. No renewals, no auto-extend — when it hits zero
        you&rsquo;re off the board.
      </p>

      {/* Decision D4, stated before payment rather than at the moment it bites.
          A rule nobody was told about is a worse outcome than the rule itself,
          and this is the one a taken-down listing will ask about first. */}
      <p className="text-md mt-2 mb-0 leading-[1.6] text-ink-soft" data-forfeit-notice>
        List an account you control. A listing that breaks the <Link href="/terms">rules</Link>{" "}
        comes off the board, and the time left on it is not refunded.
      </p>
    </div>
  );
}
