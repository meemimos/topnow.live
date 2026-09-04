import { NextResponse, type NextRequest } from "next/server";

import { serverConfig } from "@/lib/config/server";
import { limiterAddress } from "@/lib/limit/address";
import { reportLimited } from "@/lib/limit/copy";
import { tooManyRequests } from "@/lib/limit/http";
import { consume } from "@/lib/limit/limiter";
import { parseReport, reportFieldErrors } from "@/lib/reports/schema";
import { reporterHash, submitReport } from "@/lib/reports/store";

export const dynamic = "force-dynamic";

/**
 * The public report endpoint (#17).
 *
 * Unauthenticated on purpose. Requiring an account to report an impersonation
 * would mean the person being impersonated has to sign up to say so, which is
 * the opposite of what a takedown path is for.
 *
 * That makes the endpoint itself an abuse vector, which is why it is limited
 * (#18) — the issue asks for exactly this, in both directions: reports are
 * limited, and the limit answers with a real 429 and a real `Retry-After` rather
 * than a silent no-op.
 *
 * ## What it does not do
 *
 * It does not take the listing down. A report is a pointer for a human; an
 * endpoint that removed a paid listing on a stranger's say-so would be a
 * takedown button with no authentication on it, which is a worse problem than
 * the one being solved.
 */
export async function POST(request: NextRequest) {
  const { RATE_LIMIT_REPORT, RATE_LIMIT_TRUSTED_PROXIES } = serverConfig();
  const address = limiterAddress(request.headers, RATE_LIMIT_TRUSTED_PROXIES);

  const gate = await consume({
    bucket: "report",
    identity: address ?? "unidentified",
    policy: RATE_LIMIT_REPORT,
  });
  if (!gate.allowed) {
    return tooManyRequests(reportLimited(gate.retryAfterMs), gate.retryAfterMs);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseReport(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", fields: reportFieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  // No address is a usable reporter identity here: the hash is what tells one
  // report from ten copies of the same one, and hashing a constant would make
  // every anonymous report look like the same person. A stable per-request value
  // is used instead, so the report is still recorded and simply carries no
  // duplicate information.
  const hash = reporterHash(address ?? `unidentified:${crypto.randomUUID()}`);

  const outcome = await submitReport(parsed.data, hash);

  if (outcome.kind === "unknown-listing") {
    return NextResponse.json({ error: "unknown_listing" }, { status: 404 });
  }

  // A duplicate answers 200 and says the same thing a first report does. Telling
  // a reporter "you already said that" invites them to try again from somewhere
  // else, and the report is genuinely on file either way.
  return NextResponse.json({ status: outcome.kind === "recorded" ? "recorded" : "already" });
}
