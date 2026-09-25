import { describe, expect, it } from "vitest";

import { REPORT_REASONS, REPORT_REASON_LABELS, parseReport } from "./schema";

/**
 * The report submission boundary (#17).
 *
 * The endpoint is public and unauthenticated by design, so everything arriving
 * at it is stranger-supplied. This is where that stops.
 */

const LISTING = "11111111-2222-4333-8444-555555555555";

describe("parseReport", () => {
  it("accepts a reason and nothing else", () => {
    const parsed = parseReport({ purchaseId: LISTING, reason: "impersonation" });
    expect(parsed.success).toBe(true);
  });

  it("accepts the optional detail and contact", () => {
    const parsed = parseReport({
      purchaseId: LISTING,
      reason: "impersonation",
      detail: "That is my account.",
      contact: "me@example.com",
    });
    expect(parsed.success && parsed.data.detail).toBe("That is my account.");
    expect(parsed.success && parsed.data.contact).toBe("me@example.com");
  });

  it("treats an empty box as an absent field", () => {
    // The database refuses a blank string in either column, and a reporter who
    // tabbed through a field has not said anything.
    const parsed = parseReport({ purchaseId: LISTING, reason: "other", detail: "   " });
    expect(parsed.success && parsed.data.detail).toBeUndefined();
  });

  it.each([
    ["a missing listing", { reason: "other" }],
    ["a listing that is not a uuid", { purchaseId: "1", reason: "other" }],
    ["a missing reason", { purchaseId: LISTING }],
    ["a reason not on the list", { purchaseId: LISTING, reason: "i just do not like them" }],
    ["nothing at all", {}],
    ["a string", "impersonation"],
  ])("refuses %s", (_label, input) => {
    expect(parseReport(input).success).toBe(false);
  });

  it("caps the detail, because an unbounded field on a public endpoint is storage", () => {
    const parsed = parseReport({
      purchaseId: LISTING,
      reason: "other",
      detail: "x".repeat(1001),
    });
    expect(parsed.success).toBe(false);
  });

  it("caps the contact for the same reason", () => {
    const parsed = parseReport({ purchaseId: LISTING, reason: "other", contact: "x".repeat(201) });
    expect(parsed.success).toBe(false);
  });
});

describe("the reasons", () => {
  it("has a label for every one", () => {
    for (const reason of REPORT_REASONS) {
      expect(REPORT_REASON_LABELS[reason]).toBeTruthy();
    }
  });

  it("keeps a way to report something the list does not cover", () => {
    // Otherwise the closed list becomes a reason not to report at all.
    expect(REPORT_REASONS).toContain("other");
  });
});
