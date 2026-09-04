"use client";

import type { ReactNode } from "react";

import { BevelButton } from "@/components/ui/bevel-button";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  PRICING_OPENING,
  flatRateRule,
  formatMoney,
  formatMultiplier,
  surgeExplanation,
} from "@/lib/pricing/format";
import type { Slot } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * The pricing dialog (#14).
 *
 * Its job is to make the model completely legible, so that nothing on the board
 * looks arbitrary. Every figure in it is live — the same ask a buyer would be
 * charged at checkout, read per request — because a static price list beside a
 * surging board is worse than no dialog at all.
 *
 * The surge paragraph describes **queued hours**, which is the model actually
 * implemented (decision D2), not the prototype's head-count wording. Under head
 * count, four people booking an hour each would move the price as much as four
 * booking a day each; that is not what happens.
 *
 * ## Where green and red are allowed
 *
 * Only in the legend swatches below, and only to explain what the chart's own
 * colours mean. They are rendered from the same tokens the chart reads, so a
 * retheme cannot leave the legend describing colours the chart no longer uses.
 * Everywhere else in the product a premium is a multiplier, never a colour.
 */

/** What each slot is, which is also why the tiers are priced differently. */
const SLOT_DESCRIPTIONS: Record<Slot, string> = {
  1: "01 — big card, embedded post",
  2: "02 — compact row",
  3: "03 — compact row",
};

export type PricingRow = {
  slot: Slot;
  baseHrCents: number;
  multiplierCm: number;
  askHrCents: number;
};

function SectionHeading({ children }: { children: string }) {
  return <div className="text-sm mt-5 font-pixel font-bold tracking-[0.04em]">{children}</div>;
}

/**
 * A legend swatch.
 *
 * Border and fill are separate because that is the distinction the legend is
 * teaching: on the chart an up candle is filled and a down candle is hollow with
 * a coloured border, so a hollow swatch must keep its border or it explains
 * nothing. The fill, not the hue, is what carries direction — which is why this
 * legend stays true in greyscale for the same reason the chart does.
 */
function Swatch({
  border,
  fill,
  round,
}: {
  border: string;
  /** Omitted for a hollow swatch, which is the point of a hollow swatch. */
  fill?: string;
  round?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mr-1.5 inline-block h-3 w-3 border align-[-2px]",
        round && "rounded-full",
        border,
        fill ?? "bg-paper",
      )}
      data-swatch={fill ? "filled" : "hollow"}
    />
  );
}

const CELL = "border border-rule px-[7px] py-1.5";
const HEAD = "border border-rule bg-well px-[7px] py-1.5 text-right font-pixel text-2xs";

export function PricingDialog({
  rows,
  showChartLegend,
  trigger,
}: {
  rows: PricingRow[];
  /**
   * The chart is held behind a flag (decision D3). When it is not on the page,
   * the legend explaining it would describe something the reader cannot see.
   */
  showChartLegend: boolean;
  trigger: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        title="PRICING"
        description="How the hourly rate, the hours you book and the slot's current surge combine."
      >
        <p className="text-[12.5px] my-0 leading-[1.65]">{PRICING_OPENING}</p>

        <table className="mt-3 w-full border-collapse text-[11.5px]">
          <caption className="sr-only">
            Base rate, current surge and the ask right now, for each slot.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD, "text-left")}>
                SLOT
              </th>
              <th scope="col" className={HEAD}>
                BASE
              </th>
              <th scope="col" className={HEAD}>
                SURGE
              </th>
              <th scope="col" className={HEAD}>
                ASK NOW
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slot}>
                {/* The description is the justification for the tier, so it sits
                    in the same row as the price rather than in a footnote. */}
                <td className={CELL}>{SLOT_DESCRIPTIONS[row.slot]}</td>
                <td className={cn(CELL, "text-right")} data-numeric>
                  {formatMoney(row.baseHrCents)}
                </td>
                <td className={cn(CELL, "text-right")} data-numeric>
                  {formatMultiplier(row.multiplierCm)}×
                </td>
                <td className={cn(CELL, "text-right")} data-numeric>
                  {formatMoney(row.askHrCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="text-[12.5px] mt-3 mb-0 leading-[1.65]">{flatRateRule()}</p>

        <SectionHeading>HOW SURGE MOVES</SectionHeading>
        <p className="text-[12.5px] mt-2 mb-0 leading-[1.65]">{surgeExplanation()}</p>

        {showChartLegend && (
          <>
            <SectionHeading>HOW TO READ THE CHART</SectionHeading>
            <div className="text-[12.5px] mt-2 flex flex-col gap-[7px] leading-[1.55]">
              <div>
                The y-axis is dollars per hour. The x-axis is clock time. One candle is one hour of
                asking price.
              </div>
              <div>
                <Swatch border="border-up" fill="bg-up" />
                Filled green: the hour closed above where it opened.
              </div>
              <div>
                <Swatch border="border-down" />
                Hollow red: the hour closed below where it opened.
              </div>
              <div>
                <Swatch border="border-navy" fill="bg-navy" round />
                Navy dot: a completed sale. Amount paid is in the trade tape.
              </div>
              <div>
                The dashed line is that slot&rsquo;s base rate. Above it means busy; sitting on it
                means available at base.
              </div>
            </div>
          </>
        )}

        <DialogClose asChild>
          <BevelButton variant="navy" size="lg" className="mt-4" asChild>
            <a href="/checkout">PAY FOR TIME</a>
          </BevelButton>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
