import { describe, expect, it } from "vitest";

import { InvalidPolicyError, describeWait, parsePolicy, retryAfterSeconds } from "./policy";

/**
 * Rate-limit policies (#18).
 *
 * The issue's requirement is that limits come from environment config rather
 * than from magic numbers in handlers, which makes this parser the place a
 * mistyped limit either gets caught or silently becomes a different limit.
 */

describe("parsePolicy", () => {
  it("reads a count, a window and a burst", () => {
    expect(parsePolicy("20/1h+5")).toMatchObject({ limit: 20, windowMs: 3_600_000, burst: 5 });
  });

  it.each([
    ["1s", 1_000],
    ["1m", 60_000],
    ["1h", 3_600_000],
    ["1d", 86_400_000],
  ])("understands %s", (window, ms) => {
    expect(parsePolicy(`10/${window}+2`).windowMs).toBe(ms);
  });

  it("derives what one request costs from the sustained rate", () => {
    // Twenty an hour is one every three minutes.
    expect(parsePolicy("20/1h+5").emissionMs).toBe(180_000);
  });

  it("derives the tolerance from the burst", () => {
    // Five back-to-back is five requests' worth of credit held in hand.
    expect(parsePolicy("20/1h+5").toleranceMs).toBe(5 * 180_000);
  });

  it.each([
    ["a missing burst", "20/1h"],
    ["a missing window unit", "20/1+5"],
    ["a zero count", "0/1h+5"],
    ["a zero burst", "20/1h+0"],
    ["a negative count", "-1/1h+5"],
    ["a fractional count", "1.5/1h+5"],
    ["an unknown unit", "20/1y+5"],
    ["prose", "twenty an hour"],
    ["nothing", ""],
  ])("refuses %s", (_label, text) => {
    expect(() => parsePolicy(text)).toThrow(InvalidPolicyError);
  });

  it("names the expected form in the error, so a bad value is fixable", () => {
    expect(() => parsePolicy("20 per hour")).toThrow(/20\/1h\+5/);
  });

  it("tolerates surrounding whitespace, which an env file will produce", () => {
    expect(parsePolicy(" 20/1h+5 ").limit).toBe(20);
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up, never down", () => {
    // Rounding down expires the wait a fraction early, which earns the caller a
    // second refusal and makes the header look like a lie.
    expect(retryAfterSeconds(1_400)).toBe(2);
  });

  it("never advises retrying immediately", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(0)).toBe(1);
  });
});

describe("describeWait", () => {
  it.each([
    [5_000, "about 5 seconds"],
    [1_000, "about 1 second"],
    [240_000, "about 4 minutes"],
    [60_000, "about 1 minute"],
    [7_200_000, "about 2 hours"],
  ])("phrases %ims as %s", (ms, text) => {
    expect(describeWait(ms)).toBe(text);
  });

  it("stays a duration rather than becoming a timestamp", () => {
    // A clock time would be in the server's zone and wrong for most readers.
    expect(describeWait(3_600_000)).not.toMatch(/\d{2}:\d{2}/);
  });
});
