import { describe, expect, it } from "vitest";

import {
  BASE_MULTIPLIER_CM,
  DURATION_HOURS,
  MAX_MULTIPLIER_CM,
  QUEUE_CAP_HOURS,
  SLOTS,
  askHrCents,
  baseHrCents,
  decayOneHour,
  decayOver,
  isDurationHours,
  isSlot,
  quote,
  quoteForQueue,
  surgeFromQueuedHours,
} from "./index";
import {
  actionLabel,
  derivation,
  formatCents,
  formatMoney,
  formatMultiplier,
  formatMultiplierAgainstBase,
  hasSurge,
  lineItem,
  slotLabel,
} from "./format";

describe("base rates", () => {
  it.each([
    [1, 500],
    [2, 300],
    [3, 200],
  ])("slot %i is %i cents an hour", (slot, cents) => {
    expect(baseHrCents(slot as 1 | 2 | 3)).toBe(cents);
  });

  it("prices every slot at base with an empty queue", () => {
    for (const slot of SLOTS) {
      expect(quoteForQueue(slot, 1, 0).askHrCents).toBe(baseHrCents(slot));
    }
  });
});

describe("surge from queued hours (decision D2)", () => {
  it("is 1.00x with nothing queued", () => {
    expect(surgeFromQueuedHours(0)).toBe(BASE_MULTIPLIER_CM);
  });

  // The reference points from the decision. Slot 01's column is what the
  // prototype's own queue depth of 12 queued hours should produce.
  it.each([
    [0, 100, 500],
    [3, 117, 585],
    [6, 133, 665],
    [9, 150, 750],
    [12, 167, 835],
    [18, 200, 1000],
  ])("%ih queued -> %i cm -> slot 01 asks %i cents", (queuedHours, cm, slot1Cents) => {
    expect(surgeFromQueuedHours(queuedHours)).toBe(cm);
    expect(askHrCents(1, cm)).toBe(slot1Cents);
  });

  it("reaches the cap exactly at QUEUE_CAP_HOURS", () => {
    expect(surgeFromQueuedHours(QUEUE_CAP_HOURS)).toBe(MAX_MULTIPLIER_CM);
    expect(surgeFromQueuedHours(QUEUE_CAP_HOURS - 1)).toBeLessThan(MAX_MULTIPLIER_CM);
  });

  it("never exceeds the cap, however long the queue", () => {
    for (const queuedHours of [19, 24, 100, 10_000]) {
      expect(surgeFromQueuedHours(queuedHours)).toBe(MAX_MULTIPLIER_CM);
    }
  });

  it("never prices below base", () => {
    expect(surgeFromQueuedHours(-5)).toBe(BASE_MULTIPLIER_CM);
  });

  it("rises monotonically with queued hours", () => {
    let previous = 0;
    for (let hours = 0; hours <= 24; hours += 1) {
      const current = surgeFromQueuedHours(hours);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("decay", () => {
  it("retains 95% of the distance above base each unsold hour", () => {
    expect(decayOneHour(200, 0)).toBe(195);
    expect(decayOneHour(195, 0)).toBe(190);
  });

  // Without this, an ask one hundredth above base would park there forever.
  it("converges all the way to base and stops", () => {
    let cm = MAX_MULTIPLIER_CM;
    for (let hour = 0; hour < 500; hour += 1) cm = decayOneHour(cm, 0);
    expect(cm).toBe(BASE_MULTIPLIER_CM);
  });

  it("never falls below base", () => {
    expect(decayOneHour(BASE_MULTIPLIER_CM, 0)).toBe(BASE_MULTIPLIER_CM);
  });

  // Demand pushes the ask up immediately; only time brings it back down.
  it("floors at whatever the current queue justifies", () => {
    expect(decayOneHour(200, 18)).toBe(200);
    expect(decayOneHour(120, 9)).toBe(150);
  });

  it("applies no decay over zero hours", () => {
    expect(decayOver(180, 0, 0)).toBe(180);
  });

  it("matches repeated single steps", () => {
    expect(decayOver(200, 3, 0)).toBe(decayOneHour(decayOneHour(decayOneHour(200, 0), 0), 0));
  });
});

describe("totals", () => {
  it.each(DURATION_HOURS)("prices %ih as the ask times the hours", (hours) => {
    const q = quote(1, hours, 167);
    expect(q.askHrCents).toBe(835);
    expect(q.totalCents).toBe(835 * hours);
  });

  // No volume discount and no duration premium: six hours costs exactly six
  // times one hour. A discount would reward the squatting this model exists to
  // prevent, and would break the chart by moving price independently of demand.
  it("is exactly linear in hours", () => {
    const oneHour = quote(1, 1, 167).totalCents;
    for (const hours of DURATION_HOURS) {
      expect(quote(1, hours, 167).totalCents).toBe(oneHour * hours);
    }
  });

  it("keeps money in whole cents for every slot, duration and multiplier", () => {
    for (const slot of SLOTS) {
      for (const hours of DURATION_HOURS) {
        for (let cm = BASE_MULTIPLIER_CM; cm <= MAX_MULTIPLIER_CM; cm += 1) {
          const q = quote(slot, hours, cm);
          expect(Number.isInteger(q.askHrCents)).toBe(true);
          expect(Number.isInteger(q.totalCents)).toBe(true);
        }
      }
    }
  });

  // The database enforces totalPaidCents = priceHrCents * durationH (#21). A
  // quote that did not satisfy it could never be persisted.
  it("satisfies the database's total constraint", () => {
    for (const slot of SLOTS) {
      for (const hours of DURATION_HOURS) {
        const q = quoteForQueue(slot, hours, 12);
        expect(q.totalCents).toBe(q.askHrCents * hours);
      }
    }
  });
});

describe("locked prices", () => {
  // Nobody already queued is ever re-priced. The engine takes the multiplier as
  // an argument precisely so a stored rate can be re-rendered unchanged.
  it("re-renders a stored rate regardless of what the queue does later", () => {
    const atPurchase = quoteForQueue(1, 3, 6);
    expect(atPurchase.multiplierCm).toBe(133);

    const queueGrows = surgeFromQueuedHours(18);
    expect(queueGrows).toBe(200);

    const rerendered = quote(1, 3, atPurchase.multiplierCm);
    expect(rerendered.askHrCents).toBe(atPurchase.askHrCents);
    expect(rerendered.totalCents).toBe(atPurchase.totalCents);
  });

  it("honours a decayed ask above what the queue alone justifies", () => {
    // Queue has drained, but the ask has not finished bleeding down.
    const q = quoteForQueue(1, 1, 0, 150);
    expect(q.multiplierCm).toBe(150);
    expect(q.askHrCents).toBe(750);
  });

  it("ignores a stale ask below what the queue justifies", () => {
    const q = quoteForQueue(1, 1, 18, 120);
    expect(q.multiplierCm).toBe(200);
  });
});

describe("guards", () => {
  it("recognises the three slots and nothing else", () => {
    expect([1, 2, 3].every(isSlot)).toBe(true);
    expect([0, 4, -1, 1.5].some(isSlot)).toBe(false);
  });

  it("recognises the five snap points and nothing else", () => {
    expect(DURATION_HOURS.every(isDurationHours)).toBe(true);
    expect([0, 2, 5, 7, 48].some(isDurationHours)).toBe(false);
  });
});

describe("displayed strings", () => {
  it("formats cents without floating point drift", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(500)).toBe("5.00");
    expect(formatCents(2505)).toBe("25.05");
    expect(formatCents(100_000)).toBe("1000.00");
  });

  it("formats money and multipliers", () => {
    expect(formatMoney(835)).toBe("$8.35");
    expect(formatMultiplier(167)).toBe("1.67");
    expect(formatMultiplier(100)).toBe("1.00");
  });

  // A premium is a multiplier, never a colour.
  it("expresses a premium against base", () => {
    expect(formatMultiplierAgainstBase(167)).toBe("1.67× base");
  });

  it("pads slot labels", () => {
    expect(slotLabel(1)).toBe("SLOT 01");
    expect(slotLabel(3)).toBe("SLOT 03");
  });

  it("says nothing about surge at base", () => {
    expect(hasSurge(100)).toBe(false);
    expect(hasSurge(101)).toBe(true);
  });

  it("states what the button does", () => {
    const q = quoteForQueue(1, 3, 12);
    expect(actionLabel(q, false)).toBe("TAKE SLOT 01 — $25.05");
    expect(actionLabel(q, true)).toBe("JOIN QUEUE FOR SLOT 01 — $25.05");
  });

  it("renders the receipt's line item and derivation", () => {
    const q = quoteForQueue(1, 3, 12);
    expect(lineItem(q)).toBe("3H AT $8.35/HR");
    expect(derivation(q)).toBe("$5.00 BASE × 1.67 SURGE × 3H");
  });

  /**
   * The point of quantising the multiplier: a buyer can multiply the three
   * numbers printed on the receipt and land exactly on the printed total. If
   * this ever fails, the receipt is lying about its own arithmetic.
   */
  it("prints a derivation whose arithmetic is exactly right", () => {
    for (const slot of SLOTS) {
      for (const hours of DURATION_HOURS) {
        for (let queuedHours = 0; queuedHours <= QUEUE_CAP_HOURS; queuedHours += 1) {
          const q = quoteForQueue(slot, hours, queuedHours);

          const printedBase = Number(formatCents(q.baseHrCents));
          const printedMultiplier = Number(formatMultiplier(q.multiplierCm));
          const printedTotal = Number(formatCents(q.totalCents));

          expect(printedBase * printedMultiplier * hours).toBeCloseTo(printedTotal, 10);
        }
      }
    }
  });

  it("prints a line item whose rate times hours is exactly the total", () => {
    for (const slot of SLOTS) {
      for (const hours of DURATION_HOURS) {
        for (let queuedHours = 0; queuedHours <= QUEUE_CAP_HOURS; queuedHours += 1) {
          const q = quoteForQueue(slot, hours, queuedHours);
          const printedRate = Number(formatCents(q.askHrCents));
          const printedTotal = Number(formatCents(q.totalCents));
          expect(printedRate * hours).toBeCloseTo(printedTotal, 10);
        }
      }
    }
  });
});
