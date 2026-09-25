import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The admin session token (#17).
 *
 * A signed value rather than a random opaque one, so there is no session table
 * to keep, expire and clean up for a surface with a handful of users. The trade
 * is that a token cannot be revoked individually — rotating `ADMIN_SESSION_SECRET`
 * revokes all of them at once, which for an admin panel with one operator is the
 * revocation story anyway.
 *
 * `base64url(payload).base64url(hmac-sha256)`. The payload is readable, which is
 * fine: it holds a username and an expiry, both of which the holder already
 * knows. What it cannot do is be edited, because the signature covers it.
 */

/** Eight hours. Long enough for a working day, short enough that a stolen laptop expires. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const SESSION_COOKIE = "topnow_admin";

export type SessionPayload = { sub: string; exp: number };

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(username: string, secret: string, now: Date = new Date()): string {
  const payload = encode({ sub: username, exp: now.getTime() + SESSION_TTL_MS });
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * The session this token proves, or null.
 *
 * Every failure returns the same null: a malformed token, a bad signature and an
 * expired one are indistinguishable to the caller, because telling them apart
 * would be telling an attacker which half of a forgery attempt was right.
 */
export function readSession(
  token: string | undefined,
  secret: string,
  now: Date = new Date(),
): SessionPayload | null {
  if (!token) return null;

  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = Buffer.from(sign(payload, secret), "base64url");

  // Length is compared separately because timingSafeEqual throws on a mismatch,
  // and a thrown exception is itself a signal about the guess.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as SessionPayload).sub !== "string" ||
    typeof (parsed as SessionPayload).exp !== "number"
  ) {
    return null;
  }

  const session = parsed as SessionPayload;
  if (session.sub.length === 0) return null;
  if (session.exp <= now.getTime()) return null;

  return session;
}
