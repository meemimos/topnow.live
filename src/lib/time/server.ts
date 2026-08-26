import "server-only";

/**
 * The server's clock, read at request time.
 *
 * The single place a server component reads the current time. Every countdown
 * in the app is measured against this value: it ships to the browser with the
 * payload, and the client measures its own offset from it (#3) rather than
 * trusting its own clock.
 *
 * Naming it also keeps `Date.now()` out of component bodies, where React's
 * purity rule rightly objects to it — a server component reading the clock is
 * fine, but it should be an explicit, named boundary rather than an incidental
 * call in the middle of rendering.
 */
export function serverNow(): number {
  return Date.now();
}
