import { describe, expect, it } from "vitest";

import { DURATION_HOURS } from "@/lib/pricing";

import { HANDLE_RULES, deriveTargetUrl } from "./platforms";
import { fieldErrors, handleListingSchema, parseCheckout, websiteListingSchema } from "./schema";

const base = { slot: 1, durationH: 3, tagline: "Open-source invoicing." } as const;

const handleListing = (overrides: Record<string, unknown> = {}) => ({
  ...base,
  platform: "github",
  handle: "mira-builds",
  ...overrides,
});

const websiteListing = (overrides: Record<string, unknown> = {}) => ({
  ...base,
  platform: "web",
  displayName: "Ledgerless",
  url: "https://ledgerless.dev",
  ...overrides,
});

describe("the target URL is derived, never supplied", () => {
  /**
   * There is no free link field. A field a user can type any URL into is both a
   * validation hole and an abuse vector (#17) — deriving it means the link
   * always matches the handle on display.
   */
  it.each([
    ["github", "mira", "https://github.com/mira"],
    ["youtube", "parcelkit", "https://youtube.com/@parcelkit"],
    ["instagram", "studio.offcut", "https://instagram.com/studio.offcut"],
    ["tiktok", "halfbuilt", "https://tiktok.com/@halfbuilt"],
    ["reddit", "kerncase", "https://reddit.com/user/kerncase"],
  ])("%s/%s becomes %s", (platform, handle, expected) => {
    const result = parseCheckout(handleListing({ platform, handle }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetUrl).toBe(expected);
  });

  it("ignores a targetUrl someone posts alongside the handle", () => {
    const result = parseCheckout(
      handleListing({ handle: "mira", targetUrl: "https://evil.example/phish" }),
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetUrl).toBe("https://github.com/mira");
  });

  it("derives from the trimmed handle", () => {
    const result = parseCheckout(handleListing({ handle: "  mira  " }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.handle).toBe("mira");
      expect(result.data.targetUrl).toBe(deriveTargetUrl("github", "mira"));
    }
  });
});

describe("handles are validated against their own platform's rules", () => {
  it("accepts a valid handle on every platform", () => {
    for (const [platform, rule] of Object.entries(HANDLE_RULES)) {
      const result = parseCheckout(handleListing({ platform, handle: rule.example }));
      expect(result.success, `${platform}/${rule.example}`).toBe(true);
    }
  });

  // The same string is valid on one platform and not another, which is the
  // whole reason platform is chosen first.
  it("rejects a handle that is valid elsewhere but not here", () => {
    // Dots are fine on Instagram, not on GitHub.
    expect(parseCheckout(handleListing({ platform: "instagram", handle: "a.b" })).success).toBe(
      true,
    );
    expect(parseCheckout(handleListing({ platform: "github", handle: "a.b" })).success).toBe(false);

    // Two characters is fine on TikTok, too short for Reddit.
    expect(parseCheckout(handleListing({ platform: "tiktok", handle: "ab" })).success).toBe(true);
    expect(parseCheckout(handleListing({ platform: "reddit", handle: "ab" })).success).toBe(false);
  });

  it.each([
    ["-leading", "a hyphen at the start"],
    ["trailing-", "a hyphen at the end"],
    ["double--hyphen", "consecutive hyphens"],
  ])("rejects the GitHub handle %s (%s)", (handle) => {
    expect(parseCheckout(handleListing({ handle })).success).toBe(false);
  });

  it("rejects an empty handle", () => {
    expect(parseCheckout(handleListing({ handle: "   " })).success).toBe(false);
  });

  it("rejects a handle carrying a path or a scheme", () => {
    for (const handle of ["mira/repo", "https://github.com/mira", "mira?x=1", "mira#frag"]) {
      expect(parseCheckout(handleListing({ handle })).success, handle).toBe(false);
    }
  });

  it("says what the requirement is rather than 'invalid'", () => {
    const result = parseCheckout(handleListing({ handle: "-nope" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrors(result.error).handle).toBe(HANDLE_RULES.github.requirement);
    }
  });
});

describe("websites are the exception", () => {
  it("takes a URL and a display name instead of a handle", () => {
    const result = parseCheckout(websiteListing());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBe("Ledgerless");
      expect(result.data.targetUrl).toBe("https://ledgerless.dev/");
      // The schema's check constraint requires an empty handle for websites.
      expect(result.data.handle).toBe("");
    }
  });

  it("requires a display name", () => {
    expect(parseCheckout(websiteListing({ displayName: "  " })).success).toBe(false);
  });

  it(`caps the display name at 24 characters`, () => {
    expect(parseCheckout(websiteListing({ displayName: "a".repeat(24) })).success).toBe(true);
    expect(parseCheckout(websiteListing({ displayName: "a".repeat(25) })).success).toBe(false);
  });

  // https only. Also enforced by a check constraint (#21), but a javascript:
  // URL should never reach the database to be rejected there.
  it.each([
    "http://ledgerless.dev",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://ledgerless.dev",
    "ledgerless.dev",
    "//ledgerless.dev",
  ])("rejects the URL %s", (url) => {
    expect(parseCheckout(websiteListing({ url })).success).toBe(false);
  });

  it("accepts an https URL with a path", () => {
    const result = parseCheckout(websiteListing({ url: "https://ledgerless.dev/pricing" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.targetUrl).toBe("https://ledgerless.dev/pricing");
  });
});

describe("the tagline", () => {
  it("is capped at 60 characters", () => {
    expect(parseCheckout(handleListing({ tagline: "a".repeat(60) })).success).toBe(true);
    expect(parseCheckout(handleListing({ tagline: "a".repeat(61) })).success).toBe(false);
  });

  it("is required", () => {
    expect(parseCheckout(handleListing({ tagline: "   " })).success).toBe(false);
  });

  // It is rendered on one row of the board. A newline would break that row.
  it("rejects newlines", () => {
    expect(parseCheckout(handleListing({ tagline: "one\ntwo" })).success).toBe(false);
  });

  it("keeps text that merely looks like markup, as text", () => {
    const result = parseCheckout(handleListing({ tagline: "<b>bold</b> & fast" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tagline).toBe("<b>bold</b> & fast");
  });
});

describe("slot and duration", () => {
  it.each([1, 2, 3])("accepts slot %i", (slot) => {
    expect(parseCheckout(handleListing({ slot })).success).toBe(true);
  });

  it.each([0, 4, -1, 1.5, "1"])("rejects slot %s", (slot) => {
    expect(parseCheckout(handleListing({ slot })).success).toBe(false);
  });

  it.each(DURATION_HOURS)("accepts the %ih snap point", (durationH) => {
    expect(parseCheckout(handleListing({ durationH })).success).toBe(true);
  });

  // Never an arbitrary number of hours, however the request was constructed.
  it.each([0, 2, 5, 7, 23, 48, 1.5])("rejects %sh", (durationH) => {
    expect(parseCheckout(handleListing({ durationH })).success).toBe(false);
  });
});

describe("malformed input", () => {
  it.each([null, undefined, 42, "nope", [], {}])("rejects %s without throwing", (input) => {
    expect(() => parseCheckout(input)).not.toThrow();
    expect(parseCheckout(input).success).toBe(false);
  });

  it("rejects an unknown platform", () => {
    expect(parseCheckout(handleListing({ platform: "myspace" })).success).toBe(false);
  });
});

/**
 * The post link (#20).
 *
 * A listing carries a profile handle and oEmbed needs a post URL, so this field
 * is what makes the embedded panel possible at all. It is also the only URL in
 * the product a buyer types rather than one the product derives — which is why
 * it is validated this hard before it is ever sent anywhere.
 */
describe("the optional post link", () => {
  const base = {
    slot: 1,
    durationH: 3,
    tagline: "Open-source invoicing for freelancers who hate invoicing.",
  } as const;

  it("is optional — a listing without one is valid", () => {
    const result = handleListingSchema.safeParse({
      ...base,
      platform: "youtube",
      handle: "parcelkit",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.postUrl).toBeNull();
  });

  it("accepts a real post and stores it normalised", () => {
    const result = handleListingSchema.safeParse({
      ...base,
      platform: "youtube",
      handle: "parcelkit",
      postUrl: "https://www.youtube.com/watch?v=abc123&utm_source=twitter",
    });

    expect(result.success).toBe(true);
    // Normalised here rather than at resolution time, so the cache key is
    // settled before the row is written.
    if (result.success) {
      expect(result.data.postUrl).toBe("https://www.youtube.com/watch?v=abc123");
    }
  });

  it("rejects a profile link with a message a buyer can act on", () => {
    const result = handleListingSchema.safeParse({
      ...base,
      platform: "youtube",
      handle: "parcelkit",
      postUrl: "https://www.youtube.com/@parcelkit",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "postUrl");
      expect(issue?.message).toMatch(/specific post/);
    }
  });

  it("rejects a link on somebody else's host", () => {
    const result = handleListingSchema.safeParse({
      ...base,
      platform: "youtube",
      handle: "parcelkit",
      postUrl: "https://evil.example.com/watch?v=abc",
    });
    expect(result.success).toBe(false);
  });

  it("tells a GitHub listing to leave it blank rather than silently dropping it", () => {
    const result = handleListingSchema.safeParse({
      ...base,
      platform: "github",
      handle: "mira-builds",
      postUrl: "https://www.youtube.com/watch?v=abc123",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "postUrl");
      expect(issue?.message).toMatch(/no post embed/);
    }
  });

  it("gives a website listing no post link at all", () => {
    const result = websiteListingSchema.safeParse({
      ...base,
      platform: "web",
      displayName: "Parcelkit",
      url: "https://parcelkit.example",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.postUrl).toBeNull();
  });
});
