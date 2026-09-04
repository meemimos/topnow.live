import { describe, expect, it } from "vitest";

import { limiterAddress } from "./address";

/**
 * Which address a limit is keyed on (#18).
 *
 * This is the whole security of a per-IP limit. Read the wrong end of
 * `x-forwarded-for` and the limit is not weakened, it is removed: a client that
 * prepends a random address gets a fresh bucket on every request.
 */

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("limiterAddress", () => {
  it("takes the entry the trusted proxy wrote, not the one the client sent", () => {
    const forged = headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" });
    // 203.0.113.9 is what the single proxy in front observed. 1.1.1.1 is text
    // the client chose.
    expect(limiterAddress(forged, 1)).toBe("203.0.113.9");
  });

  it("counts hops from the right", () => {
    const chain = headers({ "x-forwarded-for": "9.9.9.9, 198.51.100.7, 203.0.113.9" });
    expect(limiterAddress(chain, 2)).toBe("198.51.100.7");
  });

  it("gives one caller one bucket however many addresses they prepend", () => {
    const first = limiterAddress(headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), 1);
    const second = limiterAddress(headers({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }), 1);
    const third = limiterAddress(headers({ "x-forwarded-for": "a, b, c, d, 203.0.113.9" }), 1);
    expect(new Set([first, second, third]).size).toBe(1);
  });

  it("refuses to guess when there are fewer entries than proxies", () => {
    // Something in front is not appending, so the header cannot be read the way
    // this function claims to read it. Returning the only entry would be trusting
    // exactly the text the hop count exists to distrust.
    expect(limiterAddress(headers({ "x-forwarded-for": "203.0.113.9" }), 2)).toBeNull();
  });

  it("ignores blank entries rather than counting them as a hop", () => {
    const padded = headers({ "x-forwarded-for": "1.1.1.1, , 203.0.113.9" });
    expect(limiterAddress(padded, 1)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when there is no forwarded chain", () => {
    expect(limiterAddress(headers({ "x-real-ip": "203.0.113.9" }), 1)).toBe("203.0.113.9");
  });

  it("prefers the forwarded chain, which is the one with hop information in it", () => {
    const both = headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.9", "x-real-ip": "1.1.1.1" });
    expect(limiterAddress(both, 1)).toBe("203.0.113.9");
  });

  it("returns null rather than a placeholder when nothing identifies the caller", () => {
    // Folding every unidentifiable request into one shared string here would let
    // a single client with a stripped header lock out everyone else. The caller
    // decides what unknown means for its own endpoint.
    expect(limiterAddress(headers({}), 1)).toBeNull();
    expect(limiterAddress(headers({ "x-real-ip": "   " }), 1)).toBeNull();
  });
});
