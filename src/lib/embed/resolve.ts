import type { Platform } from "@prisma/client";
import sharp from "sharp";

import { BlockedRequestError, JSON_ACCEPT, fetchBytes, type Transport } from "@/lib/fetch/net";
import { NotAnImageError, sniffImageFormat } from "@/lib/avatar/image";

import {
  AUTHOR_MAX,
  OEMBED_MAX_BYTES,
  OEMBED_TIMEOUT_MS,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TIMEOUT_MS,
  THUMBNAIL_WIDTH,
  TITLE_MAX,
} from "./constants";
import { NO_EMBED_REASON, providerFor, type Provider } from "./providers";
import { UnusableEmbedHtmlError, extractFrame, plainText, providerCount } from "./sanitise";

/**
 * Resolving a post into something slot 01 can render (#20).
 *
 * Server-side and cached, for the same reason as #19: a per-render oEmbed call
 * makes the board's latency hostage to three third parties, and the moment that
 * matters is a traffic spike, which is exactly when a provider will be slow.
 *
 * ## What comes back, and what is kept
 *
 * The provider's `html` is discarded. Only the iframe URL inside it survives
 * (see `sanitise.ts`), and it is rendered later by our own component with our
 * own sandbox attributes.
 *
 * The thumbnail is **fetched and stored**, not hotlinked. Pointing an `<img>` at
 * `i.ytimg.com` would put a third-party request back on the board that #19 just
 * removed, on a page nobody asked to contact YouTube from.
 */

export type ResolvedEmbed = {
  title: string | null;
  authorName: string | null;
  iframeSrc: string;
  iframeWidth: number | null;
  iframeHeight: number | null;
  thumbnail: Uint8Array<ArrayBuffer> | null;
  thumbnailWidth: number | null;
  /** Only when the provider actually reported one. Almost never — see below. */
  providerViews: number | null;
};

export type EmbedOutcome =
  | { kind: "resolved"; embed: ResolvedEmbed }
  /** Settled. No provider, a deleted post, or a response we cannot render. */
  | { kind: "unavailable"; reason: string }
  /** Transient. Worth asking again later. */
  | { kind: "failed"; reason: string };

/** The oEmbed request URL: our endpoint, their post in a query parameter. */
export function oembedUrl(provider: Provider, postUrl: string): string {
  const url = new URL(provider.endpoint);
  url.searchParams.set("url", postUrl);
  url.searchParams.set("format", "json");
  return url.toString();
}

/**
 * Fetch the provider's thumbnail into our own copy.
 *
 * Never fatal: an embed with a title, an author and a frame is perfectly
 * renderable without a picture, and failing the whole resolution because a CDN
 * was slow would cost slot 01 its panel for no reason.
 */
async function fetchThumbnail(
  provider: Provider,
  raw: unknown,
  transport: Transport | undefined,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; width: number } | null> {
  if (typeof raw !== "string" || !raw.startsWith("https://")) return null;

  const hosts = new Set(provider.thumbnailHosts);
  try {
    const { bytes } = await fetchBytes(raw, {
      isHostAllowed: (host) => hosts.has(host),
      transport,
      timeoutMs: THUMBNAIL_TIMEOUT_MS,
      maxBytes: THUMBNAIL_MAX_BYTES,
    });

    // Same rule as an avatar: content decides what a file is, and what we store
    // is our own re-encode rather than whatever arrived.
    if (!sniffImageFormat(bytes)) throw new NotAnImageError("thumbnail is not an image");

    const encoded = await sharp(Buffer.from(bytes), { failOn: "error", animated: false })
      .resize(THUMBNAIL_WIDTH, null, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4, force: true })
      .toBuffer();

    return { bytes: new Uint8Array(encoded), width: THUMBNAIL_WIDTH };
  } catch {
    // Deliberately swallowed. The caller gets `null` and renders without media.
    return null;
  }
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("oEmbed response is not an object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve one post.
 *
 * Never throws for an upstream problem, for the same reason `resolveAvatar` does
 * not: this runs on the payment path, and a bad minute at a provider must not
 * cost a purchase.
 *
 * `transport` is one seam for both calls. That is fine for the oEmbed request
 * and the thumbnail because both go through the same gate; tests that need to
 * distinguish them branch on the URL.
 */
export async function resolveEmbed(
  platform: Platform,
  postUrl: string,
  options: { transport?: Transport } = {},
): Promise<EmbedOutcome> {
  const provider = providerFor(platform);
  if (!provider) {
    return {
      kind: "unavailable",
      reason: NO_EMBED_REASON[platform] ?? "no embed for this platform",
    };
  }

  const endpointHosts = new Set(provider.endpointHosts);

  let payload: Record<string, unknown>;
  try {
    const { bytes } = await fetchBytes(oembedUrl(provider, postUrl), {
      isHostAllowed: (host) => endpointHosts.has(host),
      accept: JSON_ACCEPT,
      transport: options.transport,
      timeoutMs: OEMBED_TIMEOUT_MS,
      maxBytes: OEMBED_MAX_BYTES,
    });
    payload = parseJson(bytes);
  } catch (error) {
    // 401, 403 and 404 from an oEmbed endpoint all mean the same thing in
    // practice: the post is gone, private, or not embeddable. Asking again
    // tomorrow gets the same answer, so it is settled rather than failed.
    if (
      error instanceof BlockedRequestError &&
      /returned (401|403|404|410)\b/.test(error.message)
    ) {
      return { kind: "unavailable", reason: `post is not embeddable: ${error.message}` };
    }
    if (error instanceof SyntaxError) {
      return { kind: "unavailable", reason: "provider did not return usable JSON" };
    }
    if (error instanceof BlockedRequestError) return { kind: "failed", reason: error.message };
    return {
      kind: "failed",
      reason: `oEmbed fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  let frame;
  try {
    const html = payload.html;
    if (typeof html !== "string") throw new UnusableEmbedHtmlError("no html in the response");
    const frameHosts = new Set(provider.frameHosts);
    frame = extractFrame(html, (host) => frameHosts.has(host));
  } catch (error) {
    if (error instanceof UnusableEmbedHtmlError) {
      // The provider answered with something we will not render. Retrying gets
      // the same answer, so this is settled.
      return { kind: "unavailable", reason: error.message };
    }
    throw error;
  }

  const thumbnail = await fetchThumbnail(provider, payload.thumbnail_url, options.transport);

  return {
    kind: "resolved",
    embed: {
      title: plainText(payload.title, TITLE_MAX),
      authorName: plainText(payload.author_name, AUTHOR_MAX),
      iframeSrc: frame.src,
      iframeWidth: frame.width,
      iframeHeight: frame.height,
      thumbnail: thumbnail?.bytes ?? null,
      thumbnailWidth: thumbnail?.width ?? null,
      // None of YouTube, TikTok or Reddit put a view count in an oEmbed
      // response, so in practice this is null and the footer omits the row.
      // Read anyway, because "if the provider supplies it" is the rule, and a
      // provider that starts supplying it should not need a code change.
      providerViews: providerCount(payload.view_count ?? payload.views),
    },
  };
}
