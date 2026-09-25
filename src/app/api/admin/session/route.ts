import { NextResponse, type NextRequest } from "next/server";

import { currentAdmin, sameOrigin, sessionCookieOptions, signIn } from "@/lib/admin/auth";
import { SESSION_COOKIE } from "@/lib/admin/session";
import { adminConfigured } from "@/lib/config/server";
import { retryAfterSeconds } from "@/lib/limit/policy";

export const dynamic = "force-dynamic";

/**
 * Admin sign-in and sign-out (#17).
 *
 * A real endpoint rather than a server action, so that the rate limit on
 * authentication attempts can answer with an actual `429` and an actual
 * `Retry-After` — which #18 requires, and which a server action has no way to
 * produce because its response is a return value rather than a status line.
 *
 * When the admin surface is not configured this answers `404`, the same as
 * every other admin route. A deployment that has not set the variables does not
 * have an admin panel, and it should not have an endpoint that says so either.
 */
export async function POST(request: NextRequest) {
  if (!adminConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!sameOrigin(request.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "That is not a valid sign-in." }, { status: 400 });
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return NextResponse.json({ message: "That is not a valid sign-in." }, { status: 400 });
  }

  const result = await signIn(username, password);

  if (!result.ok) {
    const limited = result.retryAfterMs !== undefined;
    return NextResponse.json(
      { message: result.message },
      {
        status: limited ? 429 : 401,
        headers: limited
          ? { "Retry-After": String(retryAfterSeconds(result.retryAfterMs!)) }
          : undefined,
      },
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(result.maxAgeSeconds));
  return response;
}

/** Sign out. Clearing the cookie is the whole of it — there is no session table. */
export async function DELETE(request: NextRequest) {
  if (!adminConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!sameOrigin(request.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  // Not gated on being signed in: signing out when you already are signed out is
  // the outcome the caller wanted.
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}

/** Who is signed in, for the admin surface's own use. */
export async function GET() {
  if (!adminConfigured()) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const admin = await currentAdmin();
  return NextResponse.json({ admin: admin?.username ?? null });
}
