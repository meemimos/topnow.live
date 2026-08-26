"use client";

import type { CheckoutQuote } from "@/app/actions/checkout";
import { useClock } from "@/components/clock/provider";
import { MS_PER_HOUR, formatClockWithDay, ordinal } from "@/lib/time";

/**
 * Queue position, before payment (#10).
 *
 * Information order is position, then estimated start, then end. Never
 * "yours until 7:39 PM" to somebody who is fourth in line — the end time is
 * meaningless until they know when they start.
 *
 * The free-slot case is its own sentence rather than the same sentence with an
 * optional clause, so that going live immediately reads as cleanly as it is.
 */
export function QueuePosition({ quote }: { quote: CheckoutQuote }) {
  const clock = useClock();
  const now = clock.now();

  const startsAt = new Date(now.getTime() + quote.waitHours * MS_PER_HOUR);
  const endsAt = new Date(startsAt.getTime() + quote.durationH * MS_PER_HOUR);

  // The viewer's zone, so "tomorrow" means tomorrow for them.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (quote.immediate) {
    return (
      <p className="text-md m-0 leading-[1.6]">
        Yours until <strong>{formatClockWithDay(endsAt, now, zone)}</strong>.
      </p>
    );
  }

  return (
    <p className="text-md m-0 leading-[1.6]">
      You&rsquo;ll be <strong>{ordinal(quote.queuedAhead + 1)}</strong> in line. Estimated start{" "}
      <strong>{formatClockWithDay(startsAt, now, zone)}</strong>, yours until{" "}
      <strong>{formatClockWithDay(endsAt, now, zone)}</strong>.
      <span className="mt-1 block text-ink-soft">
        Estimated, because a listing taken down early frees the slot sooner.
      </span>
    </p>
  );
}
