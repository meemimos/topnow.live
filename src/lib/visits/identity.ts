import { createHash } from "node:crypto";

/**
 * Who a visit belongs to, without knowing who anybody is (#15).
 *
 * The counter needs exactly one thing: whether two requests came from the same
 * visitor or from different ones. It does not need to know anything about
 * either, and this file is written so that it cannot.
 *
 * ## What is stored
 *
 * A sha256 of the request's address and user agent, salted with a value that
 * rotates every day. The address never reaches the database. The hash is not
 * reversible, and because the salt rotates, the same person on two days produces
 * two unrelated hashes — so the table cannot be used to follow anyone, only to
 * count them.
 *
 * ## What that costs, honestly
 *
 * Two people behind one office NAT with the same browser version count as one
 * visitor. One person on a phone and a laptop counts as two. Both are wrong in
 * the ways this approach is known to be wrong; the alternative is a cookie or a
 * device fingerprint, which buys accuracy with exactly the tracking this avoids.
 * Undercounting a shared network is a better failure than following people
 * around, and it errs downward, which is the direction the build prompt's rule
 * about never inflating a count points in.
 */

/** Bot markers. Case-insensitive substrings of the user agent. */
const BOT_MARKERS = [
  "bot",
  "crawler",
  "spider",
  "scraper",
  "curl",
  "wget",
  "python-requests",
  "httpclient",
  "headlesschrome",
  "phantomjs",
  "slurp",
  "facebookexternalhit",
  "embedly",
  "quora link preview",
  "pinterest",
  "vkshare",
  "whatsapp",
  "telegrambot",
  "discordbot",
  "slackbot",
  "preview",
  "monitor",
  "uptime",
  "pingdom",
  "lighthouse",
  "gtmetrix",
  "chrome-lighthouse",
  "postman",
  "insomnia",
  "go-http-client",
  "java/",
  "okhttp",
  "axios",
  "node-fetch",
];

/**
 * Whether this request should be counted at all.
 *
 * A user-agent list is a blunt instrument and everybody knows it: a determined
 * crawler lies, and a real browser occasionally carries a string that looks like
 * a bot. It is used anyway because the failure is in the safe direction —
 * excluding a real visitor undercounts, and the rule is that a count is never
 * inflated. A missing user agent is treated as a bot for the same reason:
 * browsers send one, and things that do not are usually not people.
 */
export function looksLikeABot(userAgent: string | null): boolean {
  if (!userAgent || userAgent.trim().length === 0) return true;
  const lower = userAgent.toLowerCase();
  return BOT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The client address, as far as it can be known.
 *
 * `x-forwarded-for` is a header and therefore forgeable, which matters less here
 * than it usually would: forging it splits one visitor into many, which
 * *inflates* the count. That is the direction that must not happen, so the
 * left-most entry is taken (the original client per the standard) and the whole
 * thing is only ever an input to a hash. There is no privilege attached to it to
 * escalate.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** The salt's day, in UTC. Rotating it is what stops the hash being a tracker. */
export function saltDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Derive the visitor hash.
 *
 * `secret` is server-side configuration and never leaves the process; without it
 * the hash would be guessable from an address, which would make the stored value
 * a reversible identifier rather than an opaque one.
 */
export function visitorHash(
  { address, userAgent }: { address: string; userAgent: string },
  secret: string,
  now: Date,
): string {
  return createHash("sha256")
    .update(`${secret}:${saltDay(now)}:${address}:${userAgent}`)
    .digest("hex");
}

/** The start of the window a moment falls in. */
export function bucketFor(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
