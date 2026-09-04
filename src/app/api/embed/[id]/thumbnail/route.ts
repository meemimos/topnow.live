import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";

/**
 * TopNow's own copy of a post's thumbnail (#20).
 *
 * Same reasoning and same headers as the avatar route (#19): the bytes came from
 * outside the product, so they are sniffed and re-encoded on the way in and
 * served with a policy that stops a browser second-guessing any of it.
 *
 * Serving it from here rather than from `i.ytimg.com` is what keeps the board's
 * first paint free of third-party requests.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const embed = await getDb().embed.findUnique({
    where: { id },
    select: { status: true, thumbnail: true, updatedAt: true },
  });

  if (!embed || embed.status !== "ok" || !embed.thumbnail) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(new Uint8Array(embed.thumbnail), {
    headers: {
      "content-type": "image/webp",
      "content-length": String(embed.thumbnail.byteLength),
      // Safe: the URL carries the row's version, so new bytes get a new URL.
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      etag: `"${embed.updatedAt.getTime()}"`,
    },
  });
}
