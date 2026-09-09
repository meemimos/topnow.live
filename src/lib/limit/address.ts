/**
 * Which address a limit is counted against (#18).
 *
 * ## Why this is not the same function the visit counter uses
 *
 * `src/lib/visits/identity.ts` takes the **left-most** `x-forwarded-for` entry
 * and says so explicitly: forging that header splits one visitor into many,
 * which inflates a count in a direction that only ever makes the counter say
 * *fewer* people are one person. There is no privilege attached to it.
 *
 * A rate limit is the opposite case. Forging the left-most entry gives an
 * attacker a fresh bucket on every request, which does not degrade the limit —
 * it removes it. So the same header has to be read from the other end.
 *
 * ## Reading from the right
 *
 * `x-forwarded-for` is appended to by each proxy in turn, so the right-most
 * entries are the ones written by infrastructure the attacker does not control.
 * With `hops` proxies in front of the app, the entry `hops` from the right is
 * the address the outermost trusted proxy actually observed, and everything to
 * the left of it is a claim the client made.
 *
 * The number of hops is configuration rather than a guess, because guessing it
 * wrong is a security bug in one direction (too many hops trusts client-supplied
 * text) and a lockout in the other (too few buckets everyone behind the proxy
 * together). It defaults to 1 — one reverse proxy, the ordinary deployment —
 * and 0 says there is no proxy, so no address can be established at all.
 */

/**
 * The address to key a limit on, or `null` when it cannot be established.
 *
 * `null` is returned rather than a placeholder string so the caller has to
 * decide what an unidentifiable request means for its own endpoint. Folding
 * every unknown into one shared bucket would let a single client with a stripped
 * header lock out everyone else behind the same gap.
 */
export function limiterAddress(headers: Headers, hops: number): string | null {
  // 0 means "nothing trustworthy is in front of this app". Reading the headers
  // at all in that mode would be reading text the client wrote, so it does not.
  if (hops < 1) return null;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const entries = forwarded
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    // Counting from the right: hops=1 is the last entry, hops=2 the one before.
    const index = entries.length - hops;
    if (index >= 0 && entries[index]) return entries[index]!;

    // Fewer entries than there are proxies. Something in front of the app is not
    // appending, and the header cannot be read the way this function claims to
    // read it, so it is not read at all.
    return null;
  }

  // A single proxy that rewrites rather than appends. Same trust argument: it is
  // set by infrastructure, and a client that sets it directly is only reachable
  // when nothing is in front of the app at all.
  const real = headers.get("x-real-ip")?.trim();
  return real && real.length > 0 ? real : null;
}

/** One warning per bucket per process, not one per request. */
const warned = new Set<string>();

/**
 * Says, once, that a limit had no address to key on.
 *
 * This is a misconfiguration and it is silent by nature — the limiter still
 * works, it just stops distinguishing callers — so something has to say so. It
 * fires once per bucket per process because the alternative is a line per
 * request, which is how a real signal gets scrolled past.
 */
export function warnUnidentified(bucket: string, hops: number): void {
  if (warned.has(bucket)) return;
  warned.add(bucket);

  console.warn(
    `[limit] ${bucket}: no client address could be established ` +
      `(RATE_LIMIT_TRUSTED_PROXIES=${hops}). ` +
      (hops < 1
        ? "No proxy is configured, so there is nothing to read an address from."
        : "Nothing in front of this app is setting x-forwarded-for or x-real-ip — " +
          "check the proxy, or set RATE_LIMIT_TRUSTED_PROXIES=0 if there is none."),
  );
}

/** Only exported so a test can start from a clean slate. */
export function resetUnidentifiedWarnings(): void {
  warned.clear();
}
