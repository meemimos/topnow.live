"use client";

import { useState } from "react";

import { useClock } from "@/components/clock/provider";
import { PLATFORMS } from "@/components/board/platform";
import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import { SLOTS, type Slot } from "@/lib/pricing";
import { formatMoney, formatMultiplierAgainstBase, slotLabel } from "@/lib/pricing/format";
import { filterLedger, type Ledger, type LedgerRow } from "@/lib/purchase/ledger";
import { formatClock, formatHms } from "@/lib/time";
import { useRemainingMs } from "@/lib/time/client";
import { cn } from "@/lib/utils";

/**
 * The ledger (#11) — one table, one dataset, three sections.
 *
 * The whole point of the surface is that a queue entry and a completed sale are
 * the same record at different points in its life, so it is one `<table>` with
 * three `<tbody>` groups rather than three tables stacked up. Screen readers get
 * that structure for free; a reader gets it from the section headers.
 *
 * ## The reversal between sections
 *
 * The queue reads oldest-first because the oldest goes live next. The tape reads
 * newest-first because that is how a tape reads. Both are right and they point
 * opposite ways, so each section header states its own order — an unexplained
 * reversal inside one table looks like a sorting bug.
 *
 * ## Narrow widths
 *
 * At 360px the SLOT and BOUGHT columns drop rather than the table scrolling
 * sideways. Slot stays recoverable from the filter above and from the row's
 * context; a sideways-scrolling table is not recoverable from anything.
 *
 * Premium is a multiplier here, never a colour. Green and red belong to the
 * chart (#12) and mean price direction, so they appear nowhere in this table.
 */

const SECTIONS = [
  {
    key: "live",
    label: "ON THE BOARD NOW",
    note: "live rentals, counting down",
  },
  {
    key: "queued",
    label: "IN THE QUEUE",
    note: "oldest purchase first — earliest bought goes live soonest",
  },
  {
    key: "ended",
    label: "ENDED",
    note: "most recent first — the tape",
  },
] as const;

/** Honest copy for a section with nothing in it. No seeded rows, ever. */
function emptyCopy(section: "live" | "queued" | "ended", slot: Slot | "all"): string {
  const where = slot === "all" ? "" : ` on ${slotLabel(slot).toLowerCase()}`;

  switch (section) {
    case "live":
      return slot === "all"
        ? "Nobody on the board. All three slots are open at base price."
        : `Nobody on ${slotLabel(slot).toLowerCase()} right now. It is open at base price.`;
    case "queued":
      return `Nobody waiting${where}. Buy it and you go live the second payment clears.`;
    case "ended":
      return `Nothing has ended yet${where}. The tape fills as rentals run out.`;
  }
}

/** The badge in the status column. States what the row is, in one word. */
function badgeFor(row: LedgerRow): string {
  if (row.killed) return "KILLED";
  return row.section.toUpperCase();
}

/**
 * A live row's running countdown, against the shared server clock (#3).
 *
 * Its own component so that only live rows subscribe to the 1Hz tick. Folded into
 * `StatusClock` it would re-render every ended row once a second to redraw a
 * timestamp that cannot change — on a full tape that is two hundred renders a
 * second for nothing.
 */
function LiveClock({ endsAtMs }: { endsAtMs: number }) {
  const clock = useClock();
  return <>{formatHms(useRemainingMs(new Date(endsAtMs), clock))}</>;
}

/**
 * The right-hand clock, which means something different in each section.
 *
 * Live rows count down. Queued rows print an estimate — marked `~`, because it is
 * exact only if nothing is killed and no slot sits idle. Ended rows print when
 * they ended, which does not move.
 */
function StatusClock({ row }: { row: LedgerRow }) {
  if (row.section === "live") {
    return row.endsAtMs === null ? <>&mdash;</> : <LiveClock endsAtMs={row.endsAtMs} />;
  }

  const at = row.section === "queued" ? row.estimatedStartMs : row.endedAtMs;
  if (at === null) return <>&mdash;</>;

  // The tilde is load-bearing: a queued row's start is an estimate, and printing
  // it as a bare time would claim more than the queue can promise.
  return (
    <>
      {row.section === "queued" ? "~" : ""}
      {formatClock(new Date(at))}
    </>
  );
}

/** Shared cell chrome. Every cell in the table carries the same hairline rule. */
const CELL = "border border-rule px-[7px] py-1.5";
const NUMERIC = cn(CELL, "text-right");
/** SLOT and BOUGHT: present from 640px up, gone below it. */
const WIDE_ONLY = "hidden sm:table-cell";

function Row({ row }: { row: LedgerRow }) {
  const live = row.section === "live";
  const ended = row.section === "ended";

  // Live rows are highlighted in note; ended rows recede. Neither is a colour
  // carrying meaning about price — that is what the multiplier column is for.
  const tone = live
    ? "bg-note text-ink"
    : ended
      ? "bg-well-alt text-ink-soft"
      : "bg-paper text-ink";

  return (
    <tr>
      <td className={cn(CELL, tone)}>
        {/* A handle can be 64 characters with no spaces in it. Without a break
            opportunity the column's min-content width forces the whole table
            wider than the viewport, and a table is not allowed to scroll
            sideways here — so it breaks mid-word, exactly as the board does. */}
        <span className={cn("break-all", live && "font-bold")}>{row.name}</span>
        <span className="text-2xs ml-1.5 bg-ink px-1 py-0.5 font-pixel text-paper">
          {PLATFORMS[row.platform].tag}
        </span>
      </td>
      <td className={cn(NUMERIC, tone, WIDE_ONLY)} data-numeric>
        {String(row.slot).padStart(2, "0")}
      </td>
      <td className={cn(NUMERIC, tone)} data-numeric>
        {row.durationH}H
      </td>
      <td className={cn(NUMERIC, tone)} data-numeric>
        {/* The rate gets its own element rather than sitting as a bare text node
            beside the multiplier, so the two are separately addressable — to a
            screen reader, and to anything asserting on one without the other. */}
        <span>{formatMoney(row.askHrCents)}</span>
        {/* The premium, stated as a multiplier directly beneath the rate it
            produced — so the two can never be read apart. */}
        <span className="mt-[3px] block text-[9.5px] text-ink-soft">
          {formatMultiplierAgainstBase(row.multiplierCm)}
        </span>
      </td>
      <td className={cn(NUMERIC, tone, live && "font-bold")} data-numeric>
        {formatMoney(row.totalPaidCents)}
      </td>
      <td className={cn(NUMERIC, tone, WIDE_ONLY)} data-numeric>
        {formatClock(new Date(row.boughtAtMs))}
      </td>
      <td className={cn(NUMERIC, tone)}>
        <span
          className={cn(
            "text-2xs border border-ink px-1 py-0.5 font-pixel",
            live && "bg-ink text-paper",
            ended && "bg-well-alt text-ink-soft",
            !live && !ended && "bg-paper text-ink",
          )}
        >
          {badgeFor(row)}
        </span>
        <span className="text-base mt-1 block font-pixel" data-numeric>
          <StatusClock row={row} />
        </span>
      </td>
    </tr>
  );
}

function Section({
  label,
  note,
  rows,
  empty,
}: {
  label: string;
  note: string;
  rows: LedgerRow[];
  empty: string;
}) {
  return (
    <tbody>
      {/* A real row rather than a second <thead>, so the three sections stay one
          table and one dataset. */}
      <tr>
        <th
          scope="colgroup"
          colSpan={7}
          className="border border-rule bg-navy px-[7px] py-1.5 text-left font-normal text-paper"
        >
          <span className="text-sm font-pixel">{label}</span>
          <span className="text-base ml-2 text-navy-ink">{note}</span>
        </th>
      </tr>

      {rows.length === 0 ? (
        <tr>
          <td className="text-md border border-rule px-[7px] py-2.5" colSpan={7}>
            {empty}
          </td>
        </tr>
      ) : (
        rows.map((row) => <Row key={row.id} row={row} />)
      )}
    </tbody>
  );
}

const HEAD = "border border-rule bg-well px-[7px] py-[5px] text-right font-pixel text-2xs";

export function LedgerTable({ ledger }: { ledger: Ledger }) {
  const [slot, setSlot] = useState<Slot | "all">("all");
  // Filtering in the browser, over a dataset the server already sent whole. A
  // round trip per filter click would re-read the database to hide rows that are
  // already on the page.
  const shown = filterLedger(ledger, slot);

  return (
    <section aria-label="The ledger">
      <div className="mt-5 flex flex-wrap items-center justify-between gap-1.5 px-0.5">
        <span className="text-lg font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          THE LEDGER
        </span>
        <span className="text-sm font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          ONE ROW PER PURCHASE
        </span>
      </div>

      <Plate className="mt-1.5 p-[3px]">
        <TitleBar meta={`${shown.total} ${shown.total === 1 ? "PURCHASE" : "PURCHASES"}`}>
          QUEUED → LIVE → ENDED
        </TitleBar>

        <div className="flex flex-wrap items-center gap-1.5 px-[5px] py-[7px]">
          <span className="text-xs font-pixel" id="ledger-slot-filter">
            SLOT
          </span>
          <div className="flex gap-1" role="group" aria-labelledby="ledger-slot-filter">
            <BevelButton
              size="sm"
              className="text-sm px-2.5 py-[7px]"
              selected={slot === "all"}
              onClick={() => setSlot("all")}
            >
              ALL
            </BevelButton>
            {SLOTS.map((value) => (
              <BevelButton
                key={value}
                size="sm"
                className="text-sm px-2.5 py-[7px]"
                selected={slot === value}
                onClick={() => setSlot(value)}
                aria-label={slotLabel(value)}
              >
                {String(value).padStart(2, "0")}
              </BevelButton>
            ))}
          </div>
          <p className="text-base my-0 ml-auto max-w-[46ch]">
            Price shown against base as a multiplier, never as colour — green and red belong to the
            chart.
          </p>
        </div>

        <table className="mx-[5px] mb-[5px] w-[calc(100%-10px)] border-collapse bg-paper text-[11.5px]">
          <caption className="sr-only">
            Every purchase, in three sections: on the board now, in the queue, and ended.
          </caption>
          <thead>
            <tr>
              <th scope="col" className={cn(HEAD, "text-left")}>
                HANDLE
              </th>
              <th scope="col" className={cn(HEAD, WIDE_ONLY)}>
                SLOT
              </th>
              <th scope="col" className={HEAD}>
                DUR
              </th>
              <th scope="col" className={HEAD}>
                $/HR
              </th>
              <th scope="col" className={HEAD}>
                PAID
              </th>
              <th scope="col" className={cn(HEAD, WIDE_ONLY)}>
                BOUGHT
              </th>
              <th scope="col" className={HEAD}>
                STATUS
              </th>
            </tr>
          </thead>

          {SECTIONS.map((section) => (
            <Section
              key={section.key}
              label={section.label}
              note={section.note}
              rows={shown[section.key]}
              empty={emptyCopy(section.key, slot)}
            />
          ))}
        </table>
      </Plate>
    </section>
  );
}
