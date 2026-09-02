"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import {
  DEFAULT_RANGE_HOURS,
  MIN_CANDLES_IN_RANGE,
  RANGES,
  SPARKLINE_MAX_WIDTH,
  type RangeHours,
} from "@/lib/market/constants";
import type { Market, SlotMarket } from "@/lib/market/read";
import {
  flatSentence,
  sparseSentence,
  withinRange,
  type Candle,
  type MarketState,
} from "@/lib/market/series";
import { formatMoney, slotLabel } from "@/lib/pricing/format";
import type { Slot } from "@/lib/pricing";
import { cn } from "@/lib/utils";

/**
 * The market panel (#13) — the sparse and flat states, built before the chart.
 *
 * On day one the sparse state is the only market state that exists. Written as
 * an afterthought it reads as a failure; designed first, it reads as a market
 * that has not opened yet. That is why this ships ahead of #12.
 *
 * ## The panel keeps its shape
 *
 * The ticker strip and the range controls stay visible in every state. Only the
 * region below them changes, so switching to a slot with enough data swaps the
 * content without the panel remounting or the page jumping.
 *
 * ## What is never done here
 *
 * No interpolation, no padding, no last-value-carried-forward. Narrowing the
 * range filters the series the server sent; it never regenerates it, so a
 * missing hour stays missing at every range. The chart region (#12) is handed
 * only candles that were actually sampled.
 *
 * Green and red appear in exactly one place — the ticker's change against base,
 * which is price direction and the only thing those two colours are allowed to
 * mean.
 */

/** The ask against base, as a signed percentage. Only ever price direction. */
function changeAgainstBase(askHrCents: number, base: number) {
  const pct = ((askHrCents - base) / base) * 100;
  const rounded = Math.round(pct);
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}%`,
    direction: rounded > 0 ? "up" : rounded < 0 ? "down" : "flat",
  } as const;
}

function Ticker({
  market,
  selected,
  onSelect,
}: {
  market: SlotMarket;
  selected: boolean;
  onSelect: () => void;
}) {
  const change = changeAgainstBase(market.askHrCents, market.baseHrCents);

  return (
    <BevelButton
      selected={selected}
      size="sm"
      className="flex-1 basis-[150px] flex-col items-start px-[9px] py-2 text-left font-normal"
      onClick={onSelect}
      aria-label={`${slotLabel(market.slot)}, ${formatMoney(market.askHrCents)} per hour`}
    >
      <span className="text-sm block font-pixel font-bold">
        SLOT{String(market.slot).padStart(2, "0")}
      </span>
      <span className="text-2xl mt-[5px] block font-pixel font-bold" data-numeric>
        {formatMoney(market.askHrCents)}
      </span>
      <span
        className={cn(
          "text-base mt-1 block",
          // The only green or red on the page outside the chart, and it means
          // price direction — nothing else may borrow these two colours.
          !selected && change.direction === "up" && "text-up",
          !selected && change.direction === "down" && "text-down",
        )}
        data-numeric
      >
        {change.label} vs base {formatMoney(market.baseHrCents)}
      </span>
    </BevelButton>
  );
}

/**
 * The sparse note.
 *
 * Points at the ledger, which does have content — so the panel says something
 * true and useful rather than apologising for being empty.
 */
function SparseNote({ state }: { state: Extract<MarketState, { kind: "sparse" }> }) {
  return (
    <Plate variant="inset" surface="paper" className="mx-[5px] px-3.5 py-[18px]">
      <div className="text-md font-pixel font-bold tracking-[0.04em]">MARKET IS STILL OPENING</div>
      <p className="text-[12.5px] mt-2.5 mb-0 leading-[1.6]">{sparseSentence(state)}</p>
      <p className="text-[12.5px] mt-2 mb-0 leading-[1.6]">
        Not enough hours of trading to draw a candle chart yet. Every sale so far is in the tape
        below.
      </p>
    </Plate>
  );
}

/**
 * A range with nothing much in it.
 *
 * Deliberately *not* the sparse note: this slot is a real market with enough
 * sampled hours behind it, and telling the reader it is "still opening" would be
 * false. What is true is that the window they picked is empty, and the fix is
 * theirs — widen it.
 */
function ThinRangeNote({
  slot,
  rangeHours,
  candles,
}: {
  slot: Slot;
  rangeHours: number;
  candles: number;
}) {
  return (
    <Plate variant="inset" surface="paper" className="mx-[5px] px-3.5 py-[18px]">
      <div className="text-md font-pixel font-bold tracking-[0.04em]">NOTHING IN THIS RANGE</div>
      <p className="text-[12.5px] mt-2.5 mb-0 leading-[1.6]">
        {candles === 0
          ? `Nothing was sampled on ${slotLabel(slot).toLowerCase()} in the last ${rangeHours} hours.`
          : `Only one sampled hour on ${slotLabel(slot).toLowerCase()} in the last ${rangeHours} hours — not enough to show a move.`}{" "}
        Widen the range to see its history.
      </p>
    </Plate>
  );
}

/** The flat note. An invitation, not an error — so it gets the note surface, not a warning. */
function FlatNote({ state }: { state: Extract<MarketState, { kind: "flat" }> }) {
  return (
    <Plate
      surface="note"
      className="text-md mx-[5px] mt-1.5 border-2 px-[11px] py-2.5 leading-[1.6] shadow-none"
    >
      {flatSentence(state)}
    </Plate>
  );
}

/**
 * The chart itself, loaded only in the browser.
 *
 * Lightweight Charts measures a real DOM element, so it cannot be server
 * rendered. `ssr: false` keeps it out of the server pass entirely rather than
 * rendering a shell the client immediately discards — and keeps ~50KB of chart
 * library off the critical path for the sparse state, which never draws one.
 */
const PriceChart = dynamic(() => import("./chart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <div className="min-h-[110px]" aria-hidden="true" />,
});

/** The drawn chart, in its bevelled well. */
function ChartRegion({
  candles,
  saleMs,
  baseHrCents,
  spark,
}: {
  candles: Candle[];
  saleMs: number[];
  baseHrCents: number;
  spark: boolean;
}) {
  return (
    <Plate variant="inset" surface="paper" className="mx-[5px] p-1">
      <PriceChart candles={candles} saleMs={saleMs} baseHrCents={baseHrCents} spark={spark} />
    </Plate>
  );
}

/**
 * Whether the viewport is under the sparkline threshold (#12).
 *
 * A media query in CSS could hide one and show the other, but both charts would
 * then be constructed — two canvases, two ResizeObservers, and the hidden one
 * measuring a zero-width container. So the decision is made in JS and only one
 * chart ever exists.
 *
 * Starts false so the server and the first client paint agree; the effect
 * corrects it before anything is drawn, since the chart itself is client-only.
 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${SPARKLINE_MAX_WIDTH - 1}px)`);
    const sync = () => setNarrow(query.matches);

    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return narrow;
}

export function MarketPanel({ market, now }: { market: Market; now: number }) {
  const [slot, setSlot] = useState<Slot>(1);
  const [rangeHours, setRangeHours] = useState<RangeHours>(DEFAULT_RANGE_HOURS);

  const current = market.slots.find((entry) => entry.slot === slot)!;
  const state = current.state;

  /**
   * The range narrows what is drawn, never what is true.
   *
   * Whether a slot has enough sampled hours, and whether it has been sitting at
   * base, are facts about the slot — the server settles both over the whole
   * series. Recomputing them from the trimmed view would let picking the 12-hour
   * range drop a real market back to "still opening", or make a slot look flat
   * because the only candles in view happened to be quiet ones.
   *
   * So this filters the server's series and nothing more. It never asks for a
   * new one and never regenerates one, which is also why a missing hour stays
   * missing at every range and why switching range or slot cannot flash the
   * panel.
   */
  const candles = useMemo(
    () => withinRange(current.candles, rangeHours, new Date(now)),
    [current.candles, rangeHours, now],
  );

  /**
   * Under 620px the chart collapses to a sparkline with a control to expand it
   * (#12). Measured rather than guessed from a media query, because the panel is
   * a column inside a fluid layout and its width is not the viewport's.
   */
  const narrow = useNarrow();
  const [expanded, setExpanded] = useState(false);
  const spark = narrow && !expanded;

  /**
   * A range with too little in it degrades to the sparse note rather than
   * drawing a stub (#12). This is not the reveal threshold — the slot is a real
   * market either way — it is that one candle in a twelve-hour window has no
   * movement to show, and a two-pixel chart claims more than it can support.
   */
  const tooThinToDraw = state.kind !== "sparse" && candles.length < MIN_CANDLES_IN_RANGE;

  return (
    <section aria-label="The market">
      <div className="mt-5 flex flex-wrap items-center justify-between gap-1.5 px-0.5">
        <span className="text-lg font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          THE MARKET
        </span>
        <span className="text-sm font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          ASK = BASE RATE × SURGE
        </span>
      </div>

      <Plate className="mt-1.5 p-[3px]">
        <TitleBar meta="DOLLARS PER HOUR">MARKET — $/HR</TitleBar>

        {/* The ticker strip. Stays put in every state, so the panel keeps its
            shape whether or not there is a chart to show — and sticks to the top
            once the chart scrolls past, where it doubles as the summary (#12). */}
        <div
          className="sticky top-0 z-10 flex flex-wrap gap-1 bg-plate px-[5px] pt-1.5 pb-1"
          role="group"
          aria-label="Pick a slot"
        >
          {market.slots.map((entry) => (
            <Ticker
              key={entry.slot}
              market={entry}
              selected={entry.slot === slot}
              onSelect={() => setSlot(entry.slot)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-[5px] py-2">
          <span className="text-xs font-pixel" id="market-range">
            RANGE
          </span>
          <div className="flex gap-1" role="group" aria-labelledby="market-range">
            {RANGES.map((range) => (
              <BevelButton
                key={range.hours}
                size="sm"
                className="text-sm px-2.5 py-[7px]"
                selected={range.hours === rangeHours}
                onClick={() => setRangeHours(range.hours)}
              >
                {range.label}
              </BevelButton>
            ))}
          </div>
          <p className="text-base my-0 ml-auto">
            1-hour candles · <span className="font-bold">filled = up</span>, hollow = down · navy
            dot = sale
          </p>
        </div>

        {state.kind === "sparse" ? (
          <SparseNote state={state} />
        ) : tooThinToDraw ? (
          <ThinRangeNote slot={state.slot} rangeHours={rangeHours} candles={candles.length} />
        ) : (
          <>
            {/* One region in both remaining states, so a slot that is flat and
                one that is moving render the same shape — only the note below
                differs, and the panel never remounts between them. */}
            <ChartRegion
              candles={candles}
              saleMs={current.saleMs}
              baseHrCents={current.baseHrCents}
              spark={spark}
            />
            {spark && (
              <div className="px-[5px] pt-1.5">
                <BevelButton size="lg" className="py-3" onClick={() => setExpanded(true)}>
                  SHOW FULL CHART
                </BevelButton>
              </div>
            )}
            {state.kind === "flat" && <FlatNote state={state} />}
          </>
        )}

        {/* Attribution is a licence requirement of Lightweight Charts, so it gets
            a deliberate, visible home in the footer rather than a watermark that
            could be mistaken for decoration and styled away. */}
        <div className="text-2xs mx-[5px] mt-2 mb-[5px] flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 border border-ink bg-well px-2 py-1.5 font-pixel shadow-plate">
          <span>CHART ENGINE</span>
          <a
            className="text-base font-sans"
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Charts by TradingView
          </a>
        </div>
      </Plate>
    </section>
  );
}
