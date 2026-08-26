"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The client half of server-authoritative time (#3).
 *
 * The server ships its `now` with the payload; the browser measures the offset
 * once and ticks against it. Nothing here reads the client clock as an
 * authority — only as a monotonic source between syncs.
 */

/** Re-measure this often, so a machine that slept does not drift silently. */
const RESYNC_INTERVAL_MS = 60_000;

/** A tab hidden longer than this is re-synced before it paints. */
const STALE_AFTER_MS = 60_000;

export type ServerClock = {
  /** The server's current time, as best we know it. */
  now: () => Date;
  /** serverNow - clientNow, in milliseconds. */
  offsetMs: number;
};

async function fetchServerNow(): Promise<number | null> {
  try {
    const response = await fetch("/api/time", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { now?: number };
    return typeof body.now === "number" ? body.now : null;
  } catch {
    return null;
  }
}

/**
 * Tracks the offset between this browser's clock and the server's.
 *
 * `initialServerNow` comes from the server-rendered payload, so the first paint
 * is already correct rather than briefly showing the client's own idea of the
 * time.
 */
export function useServerClock(initialServerNow: number): ServerClock {
  const [offsetMs, setOffsetMs] = useState(() => initialServerNow - Date.now());

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const serverNow = await fetchServerNow();
      if (cancelled || serverNow === null) return;
      setOffsetMs(serverNow - Date.now());
    };

    const interval = setInterval(sync, RESYNC_INTERVAL_MS);

    // A laptop that slept for an hour wakes with a stale countdown. Re-sync
    // before it paints rather than after the next scheduled tick.
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt > STALE_AFTER_MS) void sync();
      hiddenAt = null;
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { now: () => new Date(Date.now() + offsetMs), offsetMs };
}

/**
 * One shared 1Hz tick for the whole page.
 *
 * Every countdown on the board reads the same tick, so they cannot drift apart
 * from each other, and the page schedules one interval rather than one per clock.
 */
const tickListeners = new Set<() => void>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  if (tickHandle === null) {
    tickHandle = setInterval(() => {
      tickCount += 1;
      for (const l of tickListeners) l();
    }, 1000);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickHandle !== null) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  };
}

const getTick = () => tickCount;
// The server renders one frame; there is nothing to tick.
const getServerTick = () => 0;

export function useTick(): number {
  return useSyncExternalStore(subscribeTick, getTick, getServerTick);
}

/**
 * Milliseconds remaining on a rental, ticking once a second.
 *
 * Monotonic by construction: the returned value never increases. A re-sync that
 * corrects the offset backwards would otherwise make a countdown run backwards
 * — `00:04` to `00:07` reads as broken in a way that being two seconds out never
 * does — so a correction that would do that is held until real time catches up.
 *
 * Under `prefers-reduced-motion` this keeps running. Clocks still tick; that is
 * the one thing reduced motion does not switch off.
 */
export function useRemainingMs(endsAt: Date | null, clock: ServerClock): number {
  // Re-renders once a second, and is otherwise unused: the value comes from the
  // clock, not from the tick count.
  useTick();

  const key = endsAt?.getTime() ?? null;
  const raw = endsAt === null ? 0 : Math.max(0, endsAt.getTime() - clock.now().getTime());

  const [shown, setShown] = useState({ key, value: raw });

  // Adjusting state during render, which React documents for exactly this: a
  // value derived from props that also has to remember something across renders.
  // A ref would be wrong — reading or writing one during render breaks under
  // concurrent rendering, and the value is needed to render.
  const next =
    shown.key === key
      ? // Never let the countdown run backwards. A re-sync that corrects the
        // offset the wrong way would otherwise show 00:04 then 00:07, which
        // reads as broken in a way that being two seconds out never does.
        { key, value: Math.min(shown.value, raw) }
      : // A different rental starts its own countdown; the previous one's floor
        // would otherwise pin it to zero.
        { key, value: raw };

  if (next.key !== shown.key || next.value !== shown.value) {
    setShown(next);
  }

  return next.value;
}
