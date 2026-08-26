import { NextResponse } from "next/server";

// The clock every countdown on the page is measured against (#3). Never cached:
// a cached time is the one thing this endpoint must not return.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { now: Date.now() },
    { headers: { "cache-control": "no-store, max-age=0" } },
  );
}
