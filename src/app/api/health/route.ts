import { NextResponse } from "next/server";

import { checkDatabaseConnection } from "@/lib/db";

// Never cached — a health check that reports a cached result is not a health check.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await checkDatabaseConnection();
    return NextResponse.json({ status: "ok", database: "up" });
  } catch (error) {
    // The message can carry connection details, so it is logged rather than returned.
    console.error("[health] database check failed", error);
    return NextResponse.json({ status: "error", database: "down" }, { status: 503 });
  }
}
