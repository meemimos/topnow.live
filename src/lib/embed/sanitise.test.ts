import { describe, expect, it } from "vitest";

import { UnusableEmbedHtmlError, extractFrame, plainText, providerCount } from "./sanitise";

/**
 * What survives contact with a provider's oEmbed response (#20).
 *
 * The design decision under test: the provider's markup is **discarded**, and
 * only the iframe URL inside it is kept. So the cases below are not "does the
 * sanitiser strip this tag" but "does anything other than a single allow-listed
 * iframe URL get through at all". Nothing should.
 */

const allowed = (host: string) => ["www.youtube-nocookie.com", "www.youtube.com"].includes(host);

const REAL_YOUTUBE_HTML =
  '<iframe width="200" height="113" src="https://www.youtube.com/embed/abc123?feature=oembed" ' +
  'frameborder="0" allow="accelerometer; autoplay; clipboard-write" ' +
  'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen title="A video"></iframe>';

describe("extractFrame", () => {
  it("keeps the src, the width and the height from a real response", () => {
    const frame = extractFrame(REAL_YOUTUBE_HTML, allowed);
    expect(frame.src).toBe("https://www.youtube.com/embed/abc123?feature=oembed");
    expect(frame.width).toBe(200);
    expect(frame.height).toBe(113);
  });

  it("keeps nothing else — the returned shape is a URL and two numbers", () => {
    const frame = extractFrame(REAL_YOUTUBE_HTML, allowed);
    // Not "allowfullscreen was stripped": there is nowhere for it to have gone.
    // The permissions the frame gets are chosen by our own component.
    expect(Object.keys(frame).sort()).toEqual(["height", "src", "width"]);
  });

  it("resolves a protocol-relative src to https rather than leaving it to guess", () => {
    const frame = extractFrame('<iframe src="//www.youtube.com/embed/x"></iframe>', allowed);
    expect(frame.src).toBe("https://www.youtube.com/embed/x");
  });

  it("accepts single-quoted attributes", () => {
    const frame = extractFrame("<iframe src='https://www.youtube.com/embed/x'></iframe>", allowed);
    expect(frame.src).toBe("https://www.youtube.com/embed/x");
  });
});

describe("what it refuses", () => {
  it("refuses a response with no iframe", () => {
    // TikTok and Reddit both return a blockquote plus a script that swaps it for
    // a frame at runtime. That script would run in our page's context.
    const blockquote =
      '<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@a/video/1"></blockquote>' +
      '<script async src="https://www.tiktok.com/embed.js"></script>';
    expect(() => extractFrame(blockquote, allowed)).toThrow(UnusableEmbedHtmlError);
  });

  it("refuses a response with more than one iframe", () => {
    // "Take the first and ignore the rest" is how a second frame gets quietly
    // retained next to the one that was inspected.
    const two = `${REAL_YOUTUBE_HTML}<iframe src="https://www.youtube.com/embed/other"></iframe>`;
    expect(() => extractFrame(two, allowed)).toThrow(/more than one iframe/);
  });

  it("refuses an iframe pointing at a host that is not allowed", () => {
    const evil = '<iframe src="https://evil.example.com/steal"></iframe>';
    expect(() => extractFrame(evil, allowed)).toThrow(/not allowed/);
  });

  it.each([
    ["javascript:", '<iframe src="javascript:alert(1)"></iframe>'],
    ["data:", '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'],
    ["http:", '<iframe src="http://www.youtube.com/embed/x"></iframe>'],
    ["a relative path", '<iframe src="/embed/x"></iframe>'],
    ["no src at all", "<iframe></iframe>"],
  ])("refuses an iframe with %s", (_label, html) => {
    expect(() => extractFrame(html, allowed)).toThrow(UnusableEmbedHtmlError);
  });

  it("refuses an implausibly large response instead of parsing it", () => {
    const huge = `<iframe src="https://www.youtube.com/embed/x"></iframe>${"x".repeat(30_000)}`;
    expect(() => extractFrame(huge, allowed)).toThrow(/implausibly large/);
  });

  it("does not let a script tag through by hiding it next to a good iframe", () => {
    const mixed = `<script>fetch('/steal')</script>${REAL_YOUTUBE_HTML}`;
    // The script is not "stripped" — the returned value is a URL, so there is no
    // channel through which markup of any kind could reach the page.
    const frame = extractFrame(mixed, allowed);
    expect(frame.src).toBe("https://www.youtube.com/embed/abc123?feature=oembed");
    expect(JSON.stringify(frame)).not.toContain("script");
  });

  it("refuses a host that only looks allow-listed", () => {
    const lookalike = '<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>';
    expect(() => extractFrame(lookalike, allowed)).toThrow(/not allowed/);
  });

  it("refuses credentials smuggled into the iframe host", () => {
    const creds = '<iframe src="https://www.youtube.com@evil.example/x"></iframe>';
    expect(() => extractFrame(creds, allowed)).toThrow(/not allowed/);
  });
});

describe("plainText", () => {
  it("collapses whitespace so a title cannot break the row it sits in", () => {
    expect(plainText("  a\n\n  b  ", 100)).toBe("a b");
  });

  it("truncates with an ellipsis rather than refusing a long title", () => {
    const long = "x".repeat(500);
    const result = plainText(long, 10);
    expect(result).toHaveLength(10);
    expect(result?.endsWith("…")).toBe(true);
  });

  it.each([[""], ["   "], [null], [undefined], [42], [{}]])("returns null for %s", (value) => {
    expect(plainText(value, 100)).toBeNull();
  });
});

describe("providerCount", () => {
  it("keeps a real non-negative integer", () => {
    expect(providerCount(0)).toBe(0);
    expect(providerCount(4126)).toBe(4126);
  });

  it.each([[-1], [1.5], ["4126"], [null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "returns null for %s, so the footer omits the row",
    (value) => {
      // "We do not know" and "nobody watched it" are different claims, and a
      // zero standing in for the first is the fabrication this prevents.
      expect(providerCount(value)).toBeNull();
    },
  );
});
