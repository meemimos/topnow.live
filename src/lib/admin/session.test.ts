import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SESSION_TTL_MS, issueSession, readSession } from "./session";

/**
 * The admin session token (#17).
 *
 * A signed token rather than a random one held in a table, so what has to be
 * true is that nothing can be edited without the secret and nothing outlives its
 * expiry. Both are tested here by trying to break them.
 */

const SECRET = "a-server-side-secret-of-adequate-length";
const NOW = new Date("2026-09-04T10:00:00Z");

describe("issueSession", () => {
  it("round-trips the username", () => {
    const token = issueSession("ops", SECRET, NOW);
    expect(readSession(token, SECRET, NOW)?.sub).toBe("ops");
  });

  it("expires", () => {
    const token = issueSession("ops", SECRET, NOW);
    const later = new Date(NOW.getTime() + SESSION_TTL_MS + 1);
    // Long enough for a working day, short enough that a forgotten laptop is not
    // an open admin panel forever.
    expect(readSession(token, SECRET, later)).toBeNull();
  });

  it("is still valid a moment before it expires", () => {
    const token = issueSession("ops", SECRET, NOW);
    const nearly = new Date(NOW.getTime() + SESSION_TTL_MS - 1_000);
    expect(readSession(token, SECRET, nearly)).not.toBeNull();
  });
});

describe("readSession", () => {
  it("refuses a token signed with a different secret", () => {
    const token = issueSession("ops", "another-secret-entirely-long-enough", NOW);
    // Which is also what rotating ADMIN_SESSION_SECRET does: it signs everyone
    // out, and that is the revocation story.
    expect(readSession(token, SECRET, NOW)).toBeNull();
  });

  it("refuses an edited payload", () => {
    const token = issueSession("ops", SECRET, NOW);
    const forged = `${Buffer.from(JSON.stringify({ sub: "root", exp: 1e15 })).toString(
      "base64url",
    )}.${token.split(".")[1]}`;
    expect(readSession(forged, SECRET, NOW)).toBeNull();
  });

  it("refuses an unsigned token", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "root", exp: 1e15 })).toString("base64url");
    expect(readSession(payload, SECRET, NOW)).toBeNull();
    expect(readSession(`${payload}.`, SECRET, NOW)).toBeNull();
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["no separator", "abcdef"],
    ["a leading separator", ".abcdef"],
    ["not base64", "!!!.???"],
  ])("refuses %s", (_label, token) => {
    expect(readSession(token, SECRET, NOW)).toBeNull();
  });

  it("refuses a validly signed token with a payload that is not a session", () => {
    // Signed by us, so the signature check passes; the shape still has to hold.
    const payload = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(readSession(`${payload}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("gives the same answer for every kind of failure", () => {
    // Distinguishing "expired" from "bad signature" tells an attacker which half
    // of the forgery was right.
    const expired = issueSession("ops", SECRET, new Date(NOW.getTime() - SESSION_TTL_MS - 1));
    const wrongSecret = issueSession("ops", "a-different-secret-of-good-length", NOW);
    expect(readSession(expired, SECRET, NOW)).toBeNull();
    expect(readSession(wrongSecret, SECRET, NOW)).toBeNull();
  });
});
