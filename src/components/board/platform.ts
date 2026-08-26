import type { Platform } from "@prisma/client";

/**
 * How each platform presents on the board.
 *
 * The prefix is also what #8 uses to derive a target URL from a handle, and #19
 * to resolve an avatar — so it lives here rather than being spelled out per
 * surface.
 */
export const PLATFORMS = {
  github: { tag: "GH", label: "GitHub", prefix: "github.com/" },
  youtube: { tag: "YT", label: "YouTube", prefix: "youtube.com/@" },
  instagram: { tag: "IG", label: "Instagram", prefix: "instagram.com/" },
  tiktok: { tag: "TT", label: "TikTok", prefix: "tiktok.com/@" },
  reddit: { tag: "RD", label: "Reddit", prefix: "reddit.com/user/" },
  web: { tag: "WEB", label: "Website", prefix: "" },
} as const satisfies Record<Platform, { tag: string; label: string; prefix: string }>;

/** The name shown on the board: a handle, or a website's display name. */
export function displayNameFor(purchase: {
  platform: Platform;
  handle: string;
  displayName: string | null;
}): string {
  return purchase.platform === "web"
    ? (purchase.displayName ?? purchase.handle)
    : `@${purchase.handle}`;
}

/** The target rendered as text — the link without its scheme. */
export function linkTextFor(targetUrl: string): string {
  return targetUrl.replace(/^https:\/\//, "").replace(/\/$/, "");
}
