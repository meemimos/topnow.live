import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { serverConfig } from "@/lib/config/server";
import { lastSampledHour, runHourlyTick } from "@/lib/market/sampler";

export const dynamic = "force-dynamic";

/**
 * The hourly job endpoint (#22).
 *
 * Authenticated: an open scheduler endpoint is an unauthenticated write. The
 * comparison is constant-time, because a naive `===` on a secret leaks its
 * prefix to anyone willing to time the responses.
 */
function isAuthorised(request: NextRequest): boolean {
  const { CRON_SECRET } = serverConfig();
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  const a = Buffer.from(presented);
  const b = Buffer.from(CRON_SECRET);
  // timingSafeEqual throws on a length mismatch, which would itself be a leak,
  // so compare lengths separately and always run the constant-time compare.
  const sameLength = a.length === b.length;
  return timingSafeEqual(sameLength ? a : b, b) && sameLength;
}

export async function POST(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await runHourlyTick();
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
    // A silently dead scheduler is the failure mode to design against, so this
    // is logged loudly and reported as a failure rather than swallowed.
    console.error("[cron/hourly] tick failed", error);
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}

/** Last successful sample, so a dead scheduler is observable rather than silent. */
export async function GET(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const hour = await lastSampledHour();
  return NextResponse.json({
    status: "ok",
    lastSampledHour: hour?.toISOString() ?? null,
    staleHours: hour === null ? null : Math.floor((Date.now() - hour.getTime()) / 3_600_000),
  });
}
