"use client";

import { useClock } from "@/components/clock/provider";
import { formatClockWithSeconds } from "@/lib/time";
import { useTick } from "@/lib/time/client";

/**
 * The server's clock, in the status bar (#5).
 *
 * Reads the same shared clock every countdown reads (#3), so the footer cannot
 * disagree with the meter above it by a second — which, on a product whose whole
 * proposition is a countdown, would be the one inconsistency people notice.
 */
export function ServerTime({ serverNow }: { serverNow: number }) {
  const clock = useClock();
  // Re-renders once a second; the value itself comes from the shared clock.
  useTick();

  // On the server there is no offset to apply yet, so the first paint uses the
  // instant the page was rendered at and hydration takes over from there.
  const now = typeof window === "undefined" ? new Date(serverNow) : clock.now();

  return (
    <span data-numeric suppressHydrationWarning>
      SERVER TIME {formatClockWithSeconds(now)}
    </span>
  );
}
