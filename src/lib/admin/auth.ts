import "server-only";

import { timingSafeEqual } from "node:crypto";

import { cookies, headers } from "next/headers";

import { adminConfigured, serverConfig } from "@/lib/config/server";
import { limiterAddress } from "@/lib/limit/address";
import { adminLimited } from "@/lib/limit/copy";
import { consume } from "@/lib/limit/limiter";

import { verifyPassword } from "./password";
import { SESSION_COOKIE, SESSION_TTL_MS, issueSession, readSession } from "./session";

/**
 * Who is allowed into the admin surface (#17).
 *
 * ## The default is closed
 *
 * `adminConfigured()` is false until a password hash and a session secret are
 * both present, and while it is false every admin route behaves as though it did
 * not exist. That ordering matters: "not configured" must not be a third state
 * that is more forgiving than "not signed in", because the deployment that
 * forgets a variable is exactly the one that must not end up with an open admin
 * panel.
 *
 * ## Sign-in is rate limited, and fails closed
 *
 * A password form on a public URL is a password-guessing endpoint. This is the
 * one limiter in the product configured to **deny** when its store is
 * unreachable (#18): everywhere else an outage should not become a second
 * outage, but here the limiter is the control, and an outage must not be a way
 * to switch it off.
 */

export type Admin = { username: string };

export type SignInResult =
  | { ok: true; token: string; maxAgeSeconds: number }
  | { ok: false; message: string; retryAfterMs?: number };

/**
 * The message a failed sign-in gets, whatever went wrong.
 *
 * One message for a wrong username and a wrong password, because two would turn
 * the form into a way to enumerate usernames.
 */
const REFUSED = "That is not a valid sign-in.";

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compared in constant time even though a username is not a secret: doing it
  // the careful way everywhere means nobody has to decide, per field, whether
  // this one happens to matter.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function signIn(username: string, password: string): Promise<SignInResult> {
  if (!adminConfigured()) return { ok: false, message: REFUSED };

  const config = serverConfig();
  const address = limiterAddress(await headers(), config.RATE_LIMIT_TRUSTED_PROXIES);

  const gate = await consume({
    bucket: "admin",
    // An unidentifiable caller shares one bucket with every other
    // unidentifiable caller. On this endpoint that is the right trade: being
    // strict costs an operator behind a misconfigured proxy a few minutes, and
    // being lax costs the password.
    identity: address ?? "unidentified",
    policy: config.RATE_LIMIT_ADMIN,
    onFailure: "deny",
  });
  if (!gate.allowed) {
    return { ok: false, message: adminLimited(gate.retryAfterMs), retryAfterMs: gate.retryAfterMs };
  }

  const nameMatches = sameString(username, config.ADMIN_USERNAME);
  // The password is verified even when the username is wrong, so that a wrong
  // username does not answer faster than a wrong password.
  const passwordMatches = await verifyPassword(password, config.ADMIN_PASSWORD_HASH).catch(
    () => false,
  );

  if (!nameMatches || !passwordMatches) return { ok: false, message: REFUSED };

  return {
    ok: true,
    token: issueSession(config.ADMIN_USERNAME, config.ADMIN_SESSION_SECRET),
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** The signed-in admin, or null. The only way anything learns there is one. */
export async function currentAdmin(): Promise<Admin | null> {
  if (!adminConfigured()) return null;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = readSession(token, serverConfig().ADMIN_SESSION_SECRET);
  if (!session) return null;

  // A token signed before the username changed still verifies, because the
  // signature covers the payload rather than the current configuration. It must
  // not still be honoured.
  if (!sameString(session.sub, serverConfig().ADMIN_USERNAME)) return null;

  return { username: session.sub };
}

/**
 * How the session cookie is set.
 *
 * `httpOnly` so script cannot read it, `secure` outside development so it is not
 * sent in the clear, and `sameSite: "strict"` so a cross-site form post does not
 * carry it — which is what makes a separate CSRF token unnecessary on the admin
 * forms. `path: "/"` rather than `/admin`, so signing out clears it from every
 * path it could have been set on.
 */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: serverConfig().NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/**
 * Whether a mutating admin request came from the admin surface itself.
 *
 * Belt to `SameSite=Strict`'s braces. The cookie should already be absent on a
 * cross-site post, but this is the check that does not depend on every browser
 * in use having implemented that the same way.
 */
export function sameOrigin(requestHeaders: Headers): boolean {
  const origin = requestHeaders.get("origin");
  // Some browsers omit Origin on same-origin form posts. Absent is not proof of
  // anything either way, and rejecting on absence would break those clients.
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(serverConfig().APP_URL).origin;
  } catch {
    return false;
  }
}
