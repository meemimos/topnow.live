import type { Platform } from "@prisma/client";

import { HANDLE_RULES, isHandlePlatform } from "@/lib/checkout/platforms";

import { storedPixels } from "./constants";
import { encodeAvatar, NotAnImageError, type EncodedAvatar } from "./image";
import { BlockedRequestError, fetchImageBytes, type Transport } from "./net";

/**
 * Per-platform avatar resolution (#19).
 *
 * A resolver is a pair: the hosts it is allowed to talk to, and the URL it
 * derives from a handle. The handle is never interpolated into a *host* — only
 * into a path on a host this file names. That is the difference between a
 * resolver and an open proxy.
 *
 * ## Platforms without a resolver
 *
 * Only GitHub publishes an avatar endpoint that works without credentials.
 * YouTube needs a Data API key, Instagram and TikTok need an authenticated Graph
 * or developer token, and Reddit's public JSON now refuses unauthenticated
 * requests from datacentre addresses.
 *
 * The honest consequence is that those platforms resolve to `null` and the board
 * renders the designed placeholder. The alternative — a generic silhouette from
 * some third party, or a colour derived from the handle — would be inventing a
 * likeness for a real person, which is exactly the kind of fabrication the build
 * prompt forbids. When credentials exist, each becomes a resolver here and
 * nothing else in the pipeline changes.
 */

export type Resolver = {
  /** Hosts this platform may be fetched from, including redirect targets. */
  hosts: readonly string[];
  /** The URL to fetch for a handle, at the pixel size we intend to store. */
  url: (handle: string, pixels: number) => string;
};

export const RESOLVERS: Partial<Record<Platform, Resolver>> = {
  github: {
    // github.com issues the redirect; avatars.githubusercontent.com serves the
    // bytes. Both are listed because the hop between them is legitimate and the
    // fetcher re-checks every hop.
    hosts: ["github.com", "avatars.githubusercontent.com"],
    url: (handle, pixels) => `https://github.com/${encodeURIComponent(handle)}.png?size=${pixels}`,
  },
};

/** Why a platform has no resolver, said plainly rather than left as a gap. */
export const NO_RESOLVER_REASON: Partial<Record<Platform, string>> = {
  youtube: "YouTube avatars require a Data API key",
  instagram: "Instagram avatars require an authenticated Graph token",
  tiktok: "TikTok avatars require a developer token",
  reddit: "Reddit refuses unauthenticated profile reads from datacentre addresses",
  web: "a website listing has no avatar concept",
};

export type ResolveOutcome =
  | { kind: "resolved"; encoded: EncodedAvatar; sourceUrl: string }
  /** No resolver, or the platform genuinely has no avatar for this handle. */
  | { kind: "unavailable"; reason: string }
  /** Something went wrong that is worth retrying later. */
  | { kind: "failed"; reason: string };

/**
 * Rejects a handle the platform's own rules would not accept.
 *
 * Checkout already validated it (#8), but this function is also reachable from
 * the refresh job over rows written by older code, and a handle is the only part
 * of the fetched URL that came from a user.
 */
function handleIsWellFormed(platform: Platform, handle: string): boolean {
  if (!isHandlePlatform(platform)) return false;
  const rule = HANDLE_RULES[platform];
  return (
    handle.length >= rule.minLength && handle.length <= rule.maxLength && rule.pattern.test(handle)
  );
}

/**
 * Resolve one avatar.
 *
 * Never throws for an upstream problem: a resolver that throws on a 404 makes
 * every caller write the same try/catch, and the caller that forgets is the one
 * that takes down the payment path. Failure is a return value.
 */
export async function resolveAvatar(
  platform: Platform,
  handle: string,
  options: { transport?: Transport } = {},
): Promise<ResolveOutcome> {
  const resolver = RESOLVERS[platform];
  if (!resolver) {
    return { kind: "unavailable", reason: NO_RESOLVER_REASON[platform] ?? "no resolver" };
  }

  if (!handleIsWellFormed(platform, handle)) {
    return { kind: "unavailable", reason: "handle does not match the platform's own rules" };
  }

  const hosts = new Set(resolver.hosts);
  const url = resolver.url(handle, storedPixels("large"));

  let bytes: Uint8Array;
  let sourceUrl: string;
  try {
    const fetched = await fetchImageBytes(url, {
      isHostAllowed: (host) => hosts.has(host),
      transport: options.transport,
    });
    bytes = fetched.bytes;
    sourceUrl = fetched.finalUrl;
  } catch (error) {
    if (error instanceof BlockedRequestError) return { kind: "failed", reason: error.message };
    return {
      kind: "failed",
      reason: `fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  try {
    return { kind: "resolved", encoded: await encodeAvatar(bytes), sourceUrl };
  } catch (error) {
    if (error instanceof NotAnImageError) {
      // Bytes arrived and were not an image. Retrying will fetch the same
      // not-an-image, so this is unavailable rather than failed.
      return { kind: "unavailable", reason: error.message };
    }
    throw error;
  }
}
