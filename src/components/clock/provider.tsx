"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useServerClock, type ServerClock } from "@/lib/time/client";

/**
 * One server clock for the whole page (#3).
 *
 * Every countdown reads this, so they cannot drift apart from each other, and
 * the offset against the server is measured once rather than per component.
 */
const ClockContext = createContext<ServerClock | null>(null);

export function ServerClockProvider({
  serverNow,
  children,
}: {
  /** The server's `Date.now()` at render, so the first paint is already correct. */
  serverNow: number;
  children: ReactNode;
}) {
  const clock = useServerClock(serverNow);
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useClock(): ServerClock {
  const clock = useContext(ClockContext);
  if (!clock) {
    throw new Error("useClock must be used inside <ServerClockProvider>.");
  }
  return clock;
}
