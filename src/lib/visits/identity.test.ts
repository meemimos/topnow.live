import { describe, expect, it } from "vitest";

import { bucketFor, clientAddress, looksLikeABot, saltDay, visitorHash } from "./identity";

/**
 * Who a visit belongs to (#15).
 *
 * The counting method has to be defensible, and this is where the defence lives:
 * a one-way hash with a salt that rotates daily, and a bot filter that fails in
 * the direction of undercounting.
 */

const NOW = new Date("2026-09-04T12:34:56.000Z");
const SECRET = "a-server-side-secret-that-never-leaves-the-process";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("looksLikeABot", () => {
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0)",
    "curl/8.4.0",
    "Wget/1.21",
    "python-requests/2.31.0",
    "facebookexternalhit/1.1",
    "Slackbot-LinkExpanding 1.0",
    "TelegramBot (like TwitterBot)",
    "Mozilla/5.0 HeadlessChrome/140.0",
    "node-fetch/1.0",
    "Go-http-client/2.0",
  ])("excludes %s", (agent) => {
    expect(looksLikeABot(agent)).toBe(true);
  });

  it.each([
    CHROME,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  ])("counts a real browser", (agent) => {
    expect(looksLikeABot(agent)).toBe(false);
  });

  it.each([null, "", "   "])("treats a missing user agent as a bot", (agent) => {
    // Browsers send one. Things that do not are usually not people, and the
    // failure direction matters more than the accuracy: excluding a real
    // visitor undercounts, and a count is never allowed to be inflated.
    expect(looksLikeABot(agent)).toBe(true);
  });
});

describe("visitorHash", () => {
  const visitor = { address: "203.0.113.9", userAgent: CHROME };

  it("is a sha256 hex digest and nothing that looks like an identifier", () => {
    const hash = visitorHash(visitor, SECRET, NOW);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203.0.113.9");
    expect(hash).not.toContain("Chrome");
  });

  it("is stable for the same visitor within a day", () => {
    const morning = visitorHash(visitor, SECRET, new Date("2026-09-04T08:00:00Z"));
    const evening = visitorHash(visitor, SECRET, new Date("2026-09-04T23:59:59Z"));
    expect(morning).toBe(evening);
  });

  it("changes the next day, so it cannot follow anyone across days", () => {
    const today = visitorHash(visitor, SECRET, new Date("2026-09-04T23:00:00Z"));
    const tomorrow = visitorHash(visitor, SECRET, new Date("2026-09-05T01:00:00Z"));
    expect(today).not.toBe(tomorrow);
  });

  it("distinguishes two visitors", () => {
    const other = { address: "198.51.100.7", userAgent: CHROME };
    expect(visitorHash(visitor, SECRET, NOW)).not.toBe(visitorHash(other, SECRET, NOW));
  });

  it("distinguishes two browsers on one address", () => {
    const firefox = { address: visitor.address, userAgent: "Mozilla/5.0 Firefox/130.0" };
    expect(visitorHash(visitor, SECRET, NOW)).not.toBe(visitorHash(firefox, SECRET, NOW));
  });

  it("is not guessable without the secret", () => {
    // Without this the stored value would be a reversible identifier: anyone
    // with an address could compute the hash and look up the visitor.
    expect(visitorHash(visitor, SECRET, NOW)).not.toBe(
      visitorHash(visitor, "a-different-secret", NOW),
    );
  });
});

describe("saltDay", () => {
  it("is a UTC date, so the rotation is not a function of where the server sits", () => {
    expect(saltDay(new Date("2026-09-04T23:59:59Z"))).toBe("2026-09-04");
    expect(saltDay(new Date("2026-09-05T00:00:01Z"))).toBe("2026-09-05");
  });
});

describe("clientAddress", () => {
  it("takes the left-most forwarded entry, which is the original client", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 70.41.3.18, 150.172.238.178" });
    expect(clientAddress(headers)).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip", () => {
    expect(clientAddress(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("has a value even when nothing identifies the client", () => {
    // Everyone unidentifiable collapses to one visitor, which undercounts.
    // That is the safe direction.
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});

describe("bucketFor", () => {
  const HALF_HOUR = 30 * 60 * 1000;

  it("puts a whole window into one bucket", () => {
    const a = bucketFor(new Date("2026-09-04T12:00:00Z"), HALF_HOUR);
    const b = bucketFor(new Date("2026-09-04T12:29:59Z"), HALF_HOUR);
    // Reloading through the window is one visit, which is what makes the count
    // a count of people rather than a count of refreshes.
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("starts a new bucket at the boundary", () => {
    const before = bucketFor(new Date("2026-09-04T12:29:59Z"), HALF_HOUR);
    const after = bucketFor(new Date("2026-09-04T12:30:00Z"), HALF_HOUR);
    expect(before.toISOString()).not.toBe(after.toISOString());
  });

  it("aligns to the window rather than to the first request seen", () => {
    expect(bucketFor(new Date("2026-09-04T12:47:13Z"), HALF_HOUR).toISOString()).toBe(
      "2026-09-04T12:30:00.000Z",
    );
  });
});
