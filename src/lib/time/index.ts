import type { Purchase } from "@prisma/client";

/**
 * Server-authoritative time (#3).
 *
 * Every clock on the page is the same clock, and it is the server's. A visitor
 * with a skewed system time must not see a different countdown, and must never
 * see a rental expire early or late.
 *
 * These are pure: `now` is always a parameter. The transport that carries the
 * server's `now` to the browser, and the hook that ticks against it, are in
 * ./client.ts.
 */

export const MS_PER_HOUR = 3_600_000;

/** Milliseconds left on a rental, clamped at zero. */
export function remainingMs(endsAt: Date, now: Date): number {
  return Math.max(0, endsAt.getTime() - now.getTime());
}

/** Proportion of a rental still to run, 1 down to 0. Drives the depletion bar (#7). */
export function remainingFraction(purchase: Purchase, now: Date): number {
  if (!purchase.endsAt) return 1;
  const total = purchase.durationH * MS_PER_HOUR;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs(purchase.endsAt, now) / total));
}

export type Hms = { hours: number; minutes: number; seconds: number };

export function splitHms(ms: number): Hms {
  const total = Math.floor(Math.max(0, ms) / 1000);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `"02:47:12"`. Hours are not truncated to two digits — a 24h rental starts at 24. */
export function formatHms(ms: number): string {
  const { hours, minutes, seconds } = splitHms(ms);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** `"0:41:06"` — the compact readout slots 02 and 03 use. */
export function formatCompact(ms: number): string {
  const { hours, minutes, seconds } = splitHms(ms);
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * The 12-hour wall-clock stamp the ledger and the board use: `"7:39 PM"`.
 *
 * Rendered in a fixed time zone so the server and the browser agree. Passing the
 * viewer's zone is what makes "tomorrow" below mean tomorrow *for them*.
 */
export function formatClock(at: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(at);
}

/**
 * The same stamp with seconds, for the status bar's server clock (#5).
 *
 * Seconds because the bar is claiming to show *the server's* time — a readout
 * that only changes once a minute cannot be told from a frozen one, and the
 * whole point of printing it is that it is live.
 */
export function formatClockWithSeconds(at: Date, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone,
  }).format(at);
}

/** Whether two instants fall on different calendar days in the given zone. */
export function isDifferentDay(a: Date, b: Date, timeZone = "UTC"): boolean {
  const format = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  return format.format(a) !== format.format(b);
}

/**
 * A wall-clock stamp that says so when it lands on another day:
 * `"7:39 PM"` or `"7:39 AM tomorrow"`.
 */
export function formatClockWithDay(at: Date, now: Date, timeZone = "UTC"): string {
  const stamp = formatClock(at, timeZone);
  return isDifferentDay(at, now, timeZone) ? `${stamp} tomorrow` : stamp;
}

export type GoLiveEstimate = {
  /** 1 for next up. Position in the queue, not counting the live rental. */
  position: number;
  /** When this purchase is expected to go live. */
  startsAt: Date;
  /** When it would then end. */
  endsAt: Date;
  /** Hours of other people's rentals between now and going live. */
  waitMs: number;
  /**
   * Always true for a queued position.
   *
   * It is exact only if nothing is killed (#17) and no slot sits empty, so every
   * surface that renders it must mark it as an estimate — `~` in the ledger,
   * "estimated start" in prose (#10).
   */
  estimated: true;
};

/**
 * When a purchase joining the back of a slot's queue would go live.
 *
 *     now + remaining on the live rental + the durations of everything queued ahead
 *
 * `liveEndsAt` is null when the slot is free, in which case a new purchase goes
 * live immediately and only the queue ahead of it counts.
 */
export function estimateGoLive(
  now: Date,
  durationH: number,
  liveEndsAt: Date | null,
  queuedAheadHours: number,
): GoLiveEstimate {
  const liveRemaining = liveEndsAt ? remainingMs(liveEndsAt, now) : 0;
  const waitMs = liveRemaining + queuedAheadHours * MS_PER_HOUR;
  const startsAt = new Date(now.getTime() + waitMs);

  return {
    position: 1,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationH * MS_PER_HOUR),
    waitMs,
    estimated: true,
  };
}

/**
 * Go-live estimates for a slot's whole queue, in order.
 *
 * Each entry starts when the one before it ends, which is why this is computed
 * for the queue as a whole rather than per row: the ledger (#11) needs every
 * row's estimate to agree with its neighbours.
 */
export function estimateQueue(
  now: Date,
  queue: readonly Purchase[],
  liveEndsAt: Date | null,
): GoLiveEstimate[] {
  let cursor = new Date(now.getTime() + (liveEndsAt ? remainingMs(liveEndsAt, now) : 0));

  return queue.map((purchase, index) => {
    const startsAt = cursor;
    const endsAt = new Date(startsAt.getTime() + purchase.durationH * MS_PER_HOUR);
    cursor = endsAt;

    return {
      position: index + 1,
      startsAt,
      endsAt,
      waitMs: startsAt.getTime() - now.getTime(),
      estimated: true,
    };
  });
}

const ORDINAL_SUFFIXES = ["th", "st", "nd", "rd"] as const;

/**
 * `1 -> "1st"`, `11 -> "11th"`, `21 -> "21st"`.
 *
 * The teens are the trap: 11th, 12th and 13th do not follow the pattern their
 * last digit suggests.
 */
export function ordinal(n: number): string {
  const remainder100 = Math.abs(n) % 100;
  const remainder10 = Math.abs(n) % 10;
  const suffix =
    remainder100 >= 11 && remainder100 <= 13 ? "th" : (ORDINAL_SUFFIXES[remainder10] ?? "th");
  return `${n}${suffix}`;
}
