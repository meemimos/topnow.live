import type { Purchase } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  MS_PER_HOUR,
  estimateGoLive,
  estimateQueue,
  formatClock,
  formatClockWithDay,
  formatCompact,
  formatHms,
  isDifferentDay,
  ordinal,
  remainingFraction,
  remainingMs,
  splitHms,
} from "./index";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: "p1",
    slot: 1,
    handle: "mira_builds",
    platform: "github",
    displayName: null,
    targetUrl: "https://github.com/mira_builds",
    tagline: "tagline",
    durationH: 6,
    priceHrCents: 500,
    totalPaidCents: 3000,
    boughtAt: NOW,
    startsAt: NOW,
    endsAt: new Date(NOW.getTime() + 6 * MS_PER_HOUR),
    status: "live",
    killedAt: null,
    killedReason: null,
    stripeSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Purchase;
}

describe("remaining time", () => {
  it("counts down to the end of the window", () => {
    expect(remainingMs(new Date(NOW.getTime() + 90_000), NOW)).toBe(90_000);
  });

  // A countdown never shows negative time. The board stops showing the rental
  // at the same instant (#1).
  it("clamps at zero once the window has closed", () => {
    expect(remainingMs(new Date(NOW.getTime() - MS_PER_HOUR), NOW)).toBe(0);
  });

  it("derives the depletion bar from the window, not a stored percentage", () => {
    const p = purchase();
    expect(remainingFraction(p, NOW)).toBe(1);
    expect(remainingFraction(p, new Date(NOW.getTime() + 3 * MS_PER_HOUR))).toBe(0.5);
    expect(remainingFraction(p, new Date(NOW.getTime() + 9 * MS_PER_HOUR))).toBe(0);
  });
});

describe("formatting", () => {
  it("splits milliseconds into hours, minutes and seconds", () => {
    expect(splitHms(2 * MS_PER_HOUR + 47 * 60_000 + 12_000)).toEqual({
      hours: 2,
      minutes: 47,
      seconds: 12,
    });
  });

  it("pads to two digits", () => {
    expect(formatHms(0)).toBe("00:00:00");
    expect(formatHms(9_000)).toBe("00:00:09");
    expect(formatHms(2 * MS_PER_HOUR + 47 * 60_000 + 12_000)).toBe("02:47:12");
  });

  // A 24h rental starts at 24:00:00, so hours must not wrap at 24.
  it("does not wrap hours", () => {
    expect(formatHms(24 * MS_PER_HOUR)).toBe("24:00:00");
  });

  it("renders the compact readout without padding the leading hour", () => {
    expect(formatCompact(41 * 60_000 + 6_000)).toBe("0:41:06");
  });

  it("renders a 12-hour wall clock", () => {
    expect(formatClock(new Date("2026-08-25T19:39:00Z"))).toBe("7:39 PM");
    expect(formatClock(new Date("2026-08-25T00:05:00Z"))).toBe("12:05 AM");
  });

  it("says tomorrow when an estimate crosses midnight", () => {
    const late = new Date("2026-08-26T01:15:00Z");
    expect(isDifferentDay(late, NOW)).toBe(true);
    expect(formatClockWithDay(late, NOW)).toBe("1:15 AM tomorrow");
    expect(formatClockWithDay(new Date("2026-08-25T19:39:00Z"), NOW)).toBe("7:39 PM");
  });

  it("decides tomorrow in the viewer's zone, not the server's", () => {
    const at = new Date("2026-08-26T01:15:00Z");
    // Still the 25th in New York, so not tomorrow for that viewer.
    expect(isDifferentDay(at, NOW, "America/New_York")).toBe(false);
    expect(isDifferentDay(at, NOW, "UTC")).toBe(true);
  });
});

describe("go-live estimates", () => {
  it("goes live immediately on a free slot with nothing queued", () => {
    const estimate = estimateGoLive(NOW, 3, null, 0);
    expect(estimate.waitMs).toBe(0);
    expect(estimate.startsAt).toEqual(NOW);
    expect(estimate.endsAt).toEqual(new Date(NOW.getTime() + 3 * MS_PER_HOUR));
  });

  it("waits out the live rental and everything queued ahead", () => {
    const liveEndsAt = new Date(NOW.getTime() + 2 * MS_PER_HOUR);
    const estimate = estimateGoLive(NOW, 3, liveEndsAt, 9);

    expect(estimate.waitMs).toBe(11 * MS_PER_HOUR);
    expect(estimate.startsAt).toEqual(new Date(NOW.getTime() + 11 * MS_PER_HOUR));
    expect(estimate.endsAt).toEqual(new Date(NOW.getTime() + 14 * MS_PER_HOUR));
  });

  it("ignores a live rental whose window already closed", () => {
    const estimate = estimateGoLive(NOW, 3, new Date(NOW.getTime() - MS_PER_HOUR), 0);
    expect(estimate.waitMs).toBe(0);
  });

  // Every estimate is marked as one. It is exact only if nothing is killed and
  // no slot sits empty.
  it("marks every estimate as an estimate", () => {
    expect(estimateGoLive(NOW, 3, null, 0).estimated).toBe(true);
  });

  it("chains a queue so each entry starts when the one before it ends", () => {
    const queue = [
      purchase({ id: "a", durationH: 3, status: "queued" }),
      purchase({ id: "b", durationH: 6, status: "queued" }),
      purchase({ id: "c", durationH: 1, status: "queued" }),
    ];
    const liveEndsAt = new Date(NOW.getTime() + 2 * MS_PER_HOUR);

    const estimates = estimateQueue(NOW, queue, liveEndsAt);

    expect(estimates.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(estimates[0].startsAt).toEqual(new Date(NOW.getTime() + 2 * MS_PER_HOUR));
    expect(estimates[1].startsAt).toEqual(new Date(NOW.getTime() + 5 * MS_PER_HOUR));
    expect(estimates[2].startsAt).toEqual(new Date(NOW.getTime() + 11 * MS_PER_HOUR));

    // No gaps: each starts exactly when its predecessor ends.
    for (let i = 1; i < estimates.length; i += 1) {
      expect(estimates[i].startsAt).toEqual(estimates[i - 1].endsAt);
    }
  });

  it("starts the queue immediately when the slot is free", () => {
    const estimates = estimateQueue(NOW, [purchase({ durationH: 3, status: "queued" })], null);
    expect(estimates[0].startsAt).toEqual(NOW);
  });

  it("returns nothing for an empty queue", () => {
    expect(estimateQueue(NOW, [], null)).toEqual([]);
  });
});

describe("ordinals", () => {
  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [4, "4th"],
    [10, "10th"],
    // The teens are the trap.
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [14, "14th"],
    [21, "21st"],
    [22, "22nd"],
    [23, "23rd"],
    [101, "101st"],
    [111, "111th"],
    [112, "112th"],
    [113, "113th"],
  ])("renders %i as %s", (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});
