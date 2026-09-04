"use client";

import { ODOMETER_DIGITS, ODOMETER_MAX } from "@/lib/visits/constants";
import { cn } from "@/lib/utils";

/**
 * The hit counter (#15).
 *
 * Pure Web 1.0, and one of the best jokes on the page — which only works if the
 * number is real. Zero-padding to seven digits is presentation; a real three
 * shows as `0000003`, and that is the joke landing correctly. An inflated three
 * would be a lie told in the same space.
 *
 * ## How it rolls
 *
 * Each digit is a window onto a strip of `0`–`9` that slides. Only the digits
 * that changed move, because the strip's offset is a function of the digit's
 * value — 4 becoming 5 shifts one cell, and the six digits in front of it that
 * did not change do not shift at all.
 *
 * ## Reduced motion
 *
 * The transition is written with `motion-reduce:transition-none`, so the digit
 * changes instantly rather than rolling. (The stylesheet also neutralises
 * transitions globally under the same query; this is belt and braces, and it is
 * the one that expresses the intent locally.)
 *
 * ## Accessibility
 *
 * A screen reader gets one string — "128,407 visits since launch" — from the
 * label. The cells are `aria-hidden`, because ten stacked digits per cell is
 * exactly what a reader must not be handed.
 */

const STRIP = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function Odometer({
  value,
  label,
  className,
}: {
  value: number;
  /** The whole readout as a sentence, for assistive tech. */
  label: string;
  className?: string;
}) {
  // Clamped rather than truncated: a count past seven digits would otherwise
  // render its low digits and silently claim a much smaller number.
  const shown = Math.min(Math.max(0, Math.floor(value)), ODOMETER_MAX);
  const digits = String(shown).padStart(ODOMETER_DIGITS, "0").split("");

  return (
    <div
      className={cn(
        "inline-flex gap-[2px] border border-ink bg-ink p-[3px] shadow-[inset_1px_1px_0_var(--color-counter-bezel)]",
        className,
      )}
      role="img"
      aria-label={label}
      data-odometer
      data-value={shown}
    >
      {digits.map((digit, index) => (
        <span
          // Index is the identity here, deliberately: cell three is cell three
          // whatever it currently shows, and keying by the digit would remount
          // the cell on every change and lose the roll it exists for.
          key={index}
          aria-hidden="true"
          className="text-[22px] relative block h-[1em] w-[0.72em] overflow-hidden bg-meter-ground text-center font-pixel leading-[1em] text-meter"
        >
          <span
            className="absolute top-0 left-0 block w-full transition-transform duration-[400ms] ease-[cubic-bezier(.2,.7,.2,1)] motion-reduce:transition-none"
            style={{ transform: `translateY(${-Number(digit) * 10}%)` }}
          >
            {STRIP.map((n) => (
              <span key={n} className="block h-[1em] leading-[1em]">
                {n}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * The online-now readout: a small amber LCD.
 *
 * Padded to three digits for the same reason the odometer is padded to seven,
 * and floored at the truth for the same reason too. **Zero renders as `000`** —
 * an empty board with nobody looking at it is a real state, and the one thing
 * this must never do is invent a person to avoid printing it.
 */
export function Lcd({ value, label }: { value: number; label: string }) {
  const shown = Math.max(0, Math.floor(value));

  return (
    <span
      className="text-2xl ml-auto min-w-[3.6em] border border-ink bg-ink px-1.5 py-1 text-right font-pixel text-meter shadow-[inset_1px_1px_0_var(--color-counter-bezel)]"
      style={{ fontVariantNumeric: "tabular-nums" }}
      role="img"
      aria-label={label}
      data-lcd
      data-value={shown}
    >
      {String(shown).padStart(3, "0")}
    </span>
  );
}
