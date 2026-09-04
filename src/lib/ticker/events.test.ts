import type { AskSample, Purchase } from "@prisma/client";
import { describe as group, expect, it } from "vitest";

import { NOTHING_YET, buildTicker, describe, priceEvents, purchaseEvents } from "./events";

/**
 * The activity ticker (#16).
 *
 * The acceptance is one sentence: **every item traces to a real transition, with
 * its timestamp.** So these tests are mostly about what does *not* come out —
 * no event without a row behind it, no motion invented for a quiet board, and
 * nothing at all from an empty database.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");
const HOUR = 3_600_000;

function purchase(overrides: Partial<Purchase> = {}): Purchase {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    slot: 1,
    handle: "mira-builds",
    platform: "github",
    displayName: null,
    targetUrl: "https://github.com/mira-builds",
    postUrl: null,
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
    durationH: 3,
    priceHrCents: 500,
    totalPaidCents: 1500,
    clicks: 0,
    boughtAt: new Date(NOW.getTime() - 2 * HOUR),
    startsAt: null,
    endsAt: null,
    status: "queued",
    killedAt: null,
    killedReason: null,
    stripeSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Purchase;
}

function sample(overrides: Partial<AskSample> = {}): AskSample {
  return {
    id: 1,
    slot: 1,
    hour: NOW,
    askHrCents: 500,
    baseHrCents: 500,
    queuedHours: 0,
    createdAt: NOW,
    ...overrides,
  } as AskSample;
}

group("purchaseEvents", () => {
  it("reports a purchase joining the queue, at the moment it was bought", () => {
    const boughtAt = new Date(NOW.getTime() - HOUR);
    const events = purchaseEvents([purchase({ boughtAt })], NOW);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "queued", handle: "mira-builds", slot: 1 });
    expect(events[0]!.at).toEqual(boughtAt);
  });

  it("reports a promotion at startsAt, not at boughtAt", () => {
    const startsAt = new Date(NOW.getTime() - 30 * 60_000);
    const events = purchaseEvents([purchase({ startsAt, status: "live" })], NOW);

    expect(events.map((e) => e.kind)).toEqual(["queued", "live"]);
    expect(events[1]!.at).toEqual(startsAt);
  });

  it("reports an ending from the window, not from the status column", () => {
    // A rental whose window has closed has ended whether or not any process
    // noticed. Reading `status` would make the ticker disagree with the board.
    const startsAt = new Date(NOW.getTime() - 4 * HOUR);
    const endsAt = new Date(NOW.getTime() - HOUR);
    const events = purchaseEvents([purchase({ startsAt, endsAt, status: "live" })], NOW);

    expect(events.map((e) => e.kind)).toEqual(["queued", "live", "ended"]);
    expect(events[2]!.at).toEqual(endsAt);
  });

  it("does not report a going-live that has not happened yet", () => {
    const startsAt = new Date(NOW.getTime() + HOUR);
    const events = purchaseEvents([purchase({ startsAt })], NOW);
    expect(events.map((e) => e.kind)).toEqual(["queued"]);
  });

  it("does not report an ending that has not happened yet", () => {
    const events = purchaseEvents(
      [
        purchase({
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR),
        }),
      ],
      NOW,
    );
    expect(events.map((e) => e.kind)).toEqual(["queued", "live"]);
  });

  it("produces nothing at all from no purchases", () => {
    expect(purchaseEvents([], NOW)).toEqual([]);
  });
});

group("priceEvents", () => {
  it("reports a move only where two samples actually differ", () => {
    const events = priceEvents([
      sample({ id: 1, hour: new Date(NOW.getTime() - 3 * HOUR), askHrCents: 500 }),
      sample({ id: 2, hour: new Date(NOW.getTime() - 2 * HOUR), askHrCents: 750 }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "surge", slot: 1, multiplierCm: 150 });
  });

  it("says nothing about a slot that has not moved", () => {
    // Twelve hours of identical samples is twelve hours of nothing happening,
    // and the honest amount of ticker for that is none.
    const flat = Array.from({ length: 12 }, (_, i) =>
      sample({ id: i, hour: new Date(NOW.getTime() - i * HOUR) }),
    );
    expect(priceEvents(flat)).toEqual([]);
  });

  it("never treats the first sample on a slot as a change", () => {
    // There is no previous observation, so there is no transition. Calling it
    // "moved to base" would invent one out of the start of the record.
    expect(priceEvents([sample()])).toEqual([]);
  });

  it("distinguishes a return to base from any other move", () => {
    const events = priceEvents([
      sample({ id: 1, hour: new Date(NOW.getTime() - 2 * HOUR), askHrCents: 750 }),
      sample({ id: 2, hour: new Date(NOW.getTime() - HOUR), askHrCents: 500 }),
    ]);

    expect(events[0]).toMatchObject({ kind: "base", multiplierCm: 100 });
  });

  it("compares each slot only against itself", () => {
    const events = priceEvents([
      sample({ id: 1, slot: 1, hour: new Date(NOW.getTime() - HOUR), askHrCents: 500 }),
      sample({
        id: 2,
        slot: 2,
        hour: new Date(NOW.getTime() - HOUR),
        askHrCents: 300,
        baseHrCents: 300,
      }),
    ]);
    // Two slots, one sample each. Neither has a predecessor of its own.
    expect(events).toEqual([]);
  });

  it("orders samples before comparing them, whatever order they arrived in", () => {
    // The read fetches newest-first to get the *recent* rows; a change is only
    // visible between neighbours, and neighbours have to be in time order.
    const descending = [
      sample({ id: 2, hour: new Date(NOW.getTime() - HOUR), askHrCents: 750 }),
      sample({ id: 1, hour: new Date(NOW.getTime() - 2 * HOUR), askHrCents: 500 }),
    ];
    expect(priceEvents(descending)).toHaveLength(1);
    expect(priceEvents(descending)[0]!.kind).toBe("surge");
  });
});

group("buildTicker", () => {
  it("is empty for an empty board — nothing is invented to fill it", () => {
    expect(buildTicker([], [], NOW)).toEqual([]);
  });

  it("puts the most recent event first", () => {
    const old = purchase({ boughtAt: new Date(NOW.getTime() - 5 * HOUR), handle: "older" });
    const recent = purchase({ boughtAt: new Date(NOW.getTime() - HOUR), handle: "newer" });

    const events = buildTicker([old, recent], [], NOW);
    expect(events.map((e) => e.handle)).toEqual(["newer", "older"]);
  });

  it("keeps a same-instant pair reverse-chronological, like everything else", () => {
    // A listing bought onto a free slot goes live in the same instant. The strip
    // runs newest first, so the later event in the purchase's life comes first —
    // otherwise this one pair would read forwards inside a strip that reads
    // backwards.
    const at = new Date(NOW.getTime() - HOUR);
    const events = buildTicker([purchase({ boughtAt: at, startsAt: at })], [], NOW);
    expect(events.map((e) => e.kind)).toEqual(["live", "queued"]);
  });

  it("caps how many it shows", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      purchase({ boughtAt: new Date(NOW.getTime() - i * 60_000) }),
    );
    expect(buildTicker(many, [], NOW, 5)).toHaveLength(5);
  });

  it("shows a stale event rather than nothing, when that is the last real one", () => {
    // A quiet ticker says the last real thing that happened. Hiding it because
    // it was yesterday would be hiding information, and would leave a strip
    // that something would then be tempted to fill.
    const yesterday = new Date(NOW.getTime() - 26 * HOUR);
    const events = buildTicker([purchase({ boughtAt: yesterday })], [], NOW);

    expect(events).toHaveLength(1);
    expect(events[0]!.at).toEqual(yesterday);
  });

  it("never emits an event dated in the future", () => {
    const events = buildTicker([purchase({ boughtAt: new Date(NOW.getTime() + HOUR) })], [], NOW);
    expect(events).toEqual([]);
  });

  it("carries a real timestamp on every item", () => {
    const events = buildTicker(
      [purchase({ startsAt: new Date(NOW.getTime() - HOUR), endsAt: new Date(NOW.getTime() - 1) })],
      [
        sample({ id: 1, hour: new Date(NOW.getTime() - 2 * HOUR), askHrCents: 500 }),
        sample({ id: 2, hour: new Date(NOW.getTime() - HOUR), askHrCents: 750 }),
      ],
      NOW,
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.at).toBeInstanceOf(Date);
      expect(Number.isNaN(event.at.getTime())).toBe(false);
    }
  });
});

group("describe", () => {
  it("keeps the handle out of the surrounding sentence", () => {
    // Returned as its own value so the component can render it as its own text
    // node. It is user content, and this is what keeps it content.
    const [event] = buildTicker([purchase({ handle: "mira-builds" })], [], NOW);
    const said = describe(event!);

    expect(said.handle).toBe("@mira-builds");
    expect(said.before).not.toContain("mira");
    expect(said.after).not.toContain("mira");
  });

  it("says what happened, in the vocabulary the board uses", () => {
    const at = new Date(NOW.getTime() - HOUR);
    const queued = describe({ kind: "queued", at, slot: 2, handle: "x", multiplierCm: null });
    expect(queued.after).toBe(" joined the queue for slot 02");

    const surge = describe({ kind: "surge", at, slot: 1, handle: null, multiplierCm: 170 });
    expect(`${surge.before}${surge.after}`).toBe("slot 01 moved to 1.70× base");

    const base = describe({ kind: "base", at, slot: 3, handle: null, multiplierCm: 100 });
    expect(base.after).toBe("slot 03 back to base");
  });

  it("has no copy that is not about something that happened", () => {
    // No welcome, no tip, no heartbeat. The empty string is the only thing this
    // module says when nothing has happened, and it says it once.
    expect(NOTHING_YET).toBe("Nothing has happened on the board yet.");
  });
});
