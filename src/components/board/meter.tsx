"use client";

import { useClock } from "@/components/clock/provider";
import { formatClock, formatCompact, splitHms } from "@/lib/time";
import { useRemainingMs } from "@/lib/time/client";
import { cn } from "@/lib/utils";

/**
 * The countdown treatment (#7).
 *
 * This is the product's engine, so it gets the boldest type on the page. Amber
 * is time: a rental about to expire does not turn red, and urgency comes from
 * the digits being enormous rather than from colour.
 *
 * Nothing here reads the client clock. Time comes from the shared server clock
 * (#3), and the depletion bar is derived from the window rather than from a
 * stored percentage — a stored one could disagree with the countdown beside it.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

function Digits({ value, label, bright }: { value: string; label: string; bright?: boolean }) {
  return (
    <div className="text-center">
      <div
        className={cn(
          "text-[clamp(34px,10.5vw,56px)] leading-none font-bold",
          bright ? "text-meter-bright" : "text-meter",
        )}
      >
        {value}
      </div>
      <div className="text-2xs mt-2 text-ink-faint">{label}</div>
    </div>
  );
}

function Colon() {
  return <div className="text-[clamp(30px,9vw,48px)] leading-[1.05] text-meter-dim">:</div>;
}

export type MeterProps = {
  /** When the rental's window closes. Null renders the terminal state. */
  endsAt: Date | null;
  /** Hours booked, for the depletion bar and the "RENTED 6H" footer. */
  durationH: number;
  className?: string;
};

/** The full panel: slot 01's meter. */
export function Meter({ endsAt, durationH, className }: MeterProps) {
  const clock = useClock();
  const remaining = useRemainingMs(endsAt, clock);
  const { hours, minutes, seconds } = splitHms(remaining);

  const totalMs = durationH * 3_600_000;
  const fraction = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0;
  const percentLeft = Math.round(fraction * 100);

  return (
    <div
      className={cn("border border-ink bg-ink px-3 pt-3.5 pb-3 shadow-meter", className)}
      // The whole panel is one reading; announced on demand rather than every
      // second, which would machine-gun a screen reader.
      role="timer"
      aria-label={`Time remaining: ${hours} hours ${minutes} minutes ${seconds} seconds`}
    >
      <div className="text-xs mb-3 flex items-center justify-between gap-2 font-pixel text-ink-faint">
        <span>TIME REMAINING</span>
        {endsAt && <span className="text-meter">EXPIRES {formatClock(endsAt)}</span>}
      </div>

      <div
        className="flex items-start justify-between gap-1 font-pixel"
        data-numeric
        aria-hidden="true"
      >
        <Digits value={pad2(hours)} label="HRS" />
        <Colon />
        <Digits value={pad2(minutes)} label="MIN" />
        <Colon />
        {/* The only moving element on the page, so it is the only brighter one. */}
        <Digits value={pad2(seconds)} label="SEC" bright />
      </div>

      <div className="mt-3.5 h-3.5 border border-meter-bezel bg-ink-plate p-0.5">
        <div
          className="h-full bg-[repeating-linear-gradient(90deg,var(--color-meter)_0_6px,var(--color-meter-stripe)_6px_8px)]"
          style={{ width: `${percentLeft}%` }}
        />
      </div>

      <div className="text-xs mt-[7px] flex justify-between font-pixel text-ink-faint">
        <span>RENTED {durationH}H</span>
        <span data-numeric>{percentLeft}% LEFT</span>
      </div>
    </div>
  );
}

/** The compact readout slots 02 and 03 use: one line, no depletion bar. */
export function CompactMeter({ endsAt, className }: { endsAt: Date | null; className?: string }) {
  const clock = useClock();
  const remaining = useRemainingMs(endsAt, clock);
  const { hours, minutes, seconds } = splitHms(remaining);

  return (
    <div
      className={cn("shrink-0 bg-ink px-[7px] py-[5px] text-center", className)}
      role="timer"
      aria-label={`Time remaining: ${hours} hours ${minutes} minutes ${seconds} seconds`}
    >
      <div className="text-xl font-pixel text-meter" data-numeric aria-hidden="true">
        {formatCompact(remaining)}
      </div>
      <div className="mt-[3px] font-pixel text-[7px] text-ink-faint">LEFT</div>
    </div>
  );
}
