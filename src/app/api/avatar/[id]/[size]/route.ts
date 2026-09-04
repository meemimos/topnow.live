import { NextResponse } from "next/server";

import { isAvatarSize } from "@/lib/avatar/url";
import { getDb } from "@/lib/db";

/**
 * Serving TopNow's own copy of an avatar (#19).
 *
 * The board points at this route, never at a third-party host, so no visitor's
 * IP reaches GitHub because they looked at a leaderboard.
 *
 * ## The headers are the security boundary
 *
 * These bytes originated outside the product. They were sniffed and re-encoded
 * on the way in, which is the real defence, but the response still says so
 * explicitly: `nosniff` stops a browser second-guessing the content type, and a
 * `default-src 'none'` policy plus `sandbox` means that even if something
 * non-image were ever served from here it could not fetch, script or frame
 * anything. Defence in depth, on a path that handles hostile input by design.
 */

const IMMUTABLE = "public, max-age=31536000, immutable";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; size: string }> },
) {
  const { id, size } = await params;

  if (!isAvatarSize(size)) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Rejected before the query rather than handed to Prisma: a malformed uuid is
  // a driver error, and a driver error on a public path is a 500 that means
  // nothing to whoever caused it.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const avatar = await getDb().avatar.findUnique({
    where: { id },
    select: { status: true, contentType: true, large: true, small: true, updatedAt: true },
  });

  const bytes = size === "large" ? avatar?.large : avatar?.small;
  if (!avatar || avatar.status !== "ok" || !bytes || !avatar.contentType) {
    // No placeholder image is served here. The placeholder is a designed piece
    // of the board's markup, not a picture — returning one from an image route
    // would put a hatch pattern inside a fixed-size box that the CSS already
    // draws better.
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": avatar.contentType,
      "content-length": String(bytes.byteLength),
      // Safe because the URL carries the row's version; new bytes get a new URL.
      "cache-control": IMMUTABLE,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      etag: `"${avatar.updatedAt.getTime()}"`,
    },
  });
}
