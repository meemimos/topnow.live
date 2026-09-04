import { describe, expect, it } from "vitest";

import {
  InvalidPostUrlError,
  NO_EMBED_REASON,
  PROVIDERS,
  isValidPostUrl,
  normalisePostUrl,
  providerFor,
} from "./providers";

/**
 * Post URLs (#20).
 *
 * This is the field a buyer types, so it is the only part of an oEmbed request
 * that a stranger controls. Two jobs: refuse anything that is not a post on the
 * platform's own hosts, and reduce what is left to a stable cache key.
 */

describe("what a post URL must be", () => {
  it.each([
    ["youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["youtube", "https://www.youtube.com/shorts/abc123"],
    ["youtube", "https://youtu.be/dQw4w9WgXcQ"],
    ["tiktok", "https://www.tiktok.com/@halfbuilt/video/7301234567890123456"],
    ["reddit", "https://www.reddit.com/r/webdev/comments/abc123/some_title/"],
  ] as const)("accepts a real %s post", (platform, url) => {
    expect(isValidPostUrl(platform, url)).toBe(true);
  });

  it.each([
    ["a profile rather than a post", "youtube", "https://www.youtube.com/@parcelkit"],
    // A legacy channel URL has the same shape as a youtu.be video id. One
    // pattern covering both hosts accepted it as a post: checkout took a
    // profile link, resolution 404'd, and the row cached `unavailable` forever.
    ["a legacy channel URL", "youtube", "https://www.youtube.com/mrbeast6000"],
    ["a channel with a trailing segment", "youtube", "https://www.youtube.com/c/somechannel"],
    ["a bare /watch with no video", "youtube", "https://www.youtube.com/watch"],
    ["a tiktok profile", "tiktok", "https://www.tiktok.com/@halfbuilt"],
    ["a subreddit rather than a post", "reddit", "https://www.reddit.com/r/webdev/"],
  ] as const)("refuses %s", (_label, platform, url) => {
    // Without this the resolver would spend a request learning what the pattern
    // already knows.
    expect(() => normalisePostUrl(platform, url)).toThrow(/specific post/);
  });

  it.each([
    ["http", "http://www.youtube.com/watch?v=x"],
    ["a data URL", "data:text/html,<script>alert(1)</script>"],
    ["a file URL", "file:///etc/passwd"],
    ["not a URL", "watch?v=x"],
  ])("refuses %s", (_label, url) => {
    expect(() => normalisePostUrl("youtube", url)).toThrow(InvalidPostUrlError);
  });

  it("refuses a link on somebody else's host", () => {
    expect(() => normalisePostUrl("youtube", "https://evil.example.com/watch?v=x")).toThrow(
      /not a www.youtube.com link/,
    );
  });

  it("refuses a lookalike host", () => {
    expect(() =>
      normalisePostUrl("youtube", "https://www.youtube.com.evil.example/watch?v=x"),
    ).toThrow(/not a www.youtube.com link/);
  });

  it("refuses credentials in the link", () => {
    expect(() => normalisePostUrl("youtube", "https://user:pw@www.youtube.com/watch?v=x")).toThrow(
      /credentials/,
    );
  });

  it.each(["github", "instagram", "web"] as const)("refuses a %s post outright", (platform) => {
    expect(() => normalisePostUrl(platform, "https://example.com/post")).toThrow(
      NO_EMBED_REASON[platform],
    );
  });
});

describe("the cache key", () => {
  it("strips tracking parameters so one post is one row", () => {
    const withTracking =
      "https://www.youtube.com/watch?v=abc123&utm_source=twitter&utm_campaign=launch&si=xyz";
    expect(normalisePostUrl("youtube", withTracking)).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
  });

  it("keeps the parameters that identify the post", () => {
    // `v` is the video. Stripping it as "just a query parameter" would key every
    // YouTube link to the same row.
    const normalised = normalisePostUrl("youtube", "https://www.youtube.com/watch?v=abc123&t=42");
    expect(normalised).toContain("v=abc123");
    expect(normalised).toContain("t=42");
  });

  it("sorts parameters so order does not create a second row", () => {
    const a = normalisePostUrl("youtube", "https://www.youtube.com/watch?v=abc&t=1");
    const b = normalisePostUrl("youtube", "https://www.youtube.com/watch?t=1&v=abc");
    expect(a).toBe(b);
  });

  it("drops the fragment", () => {
    expect(normalisePostUrl("youtube", "https://www.youtube.com/watch?v=abc#t=30")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });

  it("case-folds the host but never the path", () => {
    const normalised = normalisePostUrl(
      "reddit",
      "https://WWW.Reddit.com/r/WebDev/comments/AbC123/Title/",
    );
    expect(normalised).toContain("https://www.reddit.com/");
    // A Reddit post id is case-sensitive. Folding it would key a different post.
    expect(normalised).toContain("AbC123");
  });

  it("trims surrounding whitespace from a pasted link", () => {
    expect(normalisePostUrl("youtube", "  https://www.youtube.com/watch?v=abc  ")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
  });
});

describe("the provider table", () => {
  it("never lets a post URL choose the endpoint host", () => {
    // The post goes in a query parameter of *our* endpoint. If it could choose
    // the host, the resolver would be an open proxy.
    for (const provider of Object.values(PROVIDERS)) {
      expect(new URL(provider.endpoint).protocol).toBe("https:");
      expect(provider.endpointHosts).toContain(new URL(provider.endpoint).hostname);
    }
  });

  it("has either a provider or a stated reason for every platform", () => {
    for (const platform of ["github", "youtube", "instagram", "tiktok", "reddit", "web"] as const) {
      const covered = Boolean(providerFor(platform)) !== Boolean(NO_EMBED_REASON[platform]);
      expect(covered, `${platform} needs one or the other, not both or neither`).toBe(true);
    }
  });

  it("reads a bare path as a video only on the short domain", () => {
    // The same path is a video on youtu.be and a channel on youtube.com, which
    // is exactly why this is a predicate over the URL rather than over the path.
    expect(isValidPostUrl("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isValidPostUrl("youtube", "https://www.youtube.com/dQw4w9WgXcQ")).toBe(false);
  });

  it("keeps frame hosts separate from post hosts", () => {
    // A post lives on www.youtube.com; the frame it produces lives on the
    // nocookie domain. Conflating the two lists would widen both.
    expect(PROVIDERS.youtube!.frameHosts).toContain("www.youtube-nocookie.com");
    expect(PROVIDERS.youtube!.postHosts).not.toContain("www.youtube-nocookie.com");
  });
});
