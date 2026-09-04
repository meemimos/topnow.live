import type { Platform } from "@prisma/client";

/**
 * The three platforms with a public oEmbed endpoint (#20).
 *
 * GitHub, Instagram and Website are absent deliberately. GitHub has no post to
 * embed, Instagram's oEmbed has required an app token since 2020, and a website
 * is a link rather than a post. Those platforms render the profile card as their
 * **normal state**, not as a fallback — which is why this file has no entry for
 * them rather than an entry that always fails.
 */

export type Provider = {
  /** Where the oEmbed request goes. Never derived from the post URL. */
  endpoint: string;
  /** Hosts a post URL may live on, checked before the URL is ever sent. */
  postHosts: readonly string[];
  /** Hosts the endpoint itself may be reached at, including redirects. */
  endpointHosts: readonly string[];
  /** Hosts the returned iframe may point at. Anything else is discarded. */
  frameHosts: readonly string[];
  /** Hosts a thumbnail may be fetched from. */
  thumbnailHosts: readonly string[];
  /** What a post link looks like, so a profile URL is not sent as a post. */
  postPath: RegExp;
};

export const PROVIDERS: Partial<Record<Platform, Provider>> = {
  youtube: {
    endpoint: "https://www.youtube.com/oembed",
    postHosts: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],
    endpointHosts: ["www.youtube.com", "youtube.com"],
    // The privacy-preserving host is listed first because it is what a
    // provider's own embed HTML uses when asked to; either is accepted.
    frameHosts: ["www.youtube-nocookie.com", "www.youtube.com", "youtube.com"],
    thumbnailHosts: ["i.ytimg.com", "img.youtube.com"],
    postPath: /^\/(watch|shorts\/|live\/|embed\/)|^\/[\w-]{6,}$/,
  },
  tiktok: {
    endpoint: "https://www.tiktok.com/oembed",
    postHosts: ["www.tiktok.com", "tiktok.com", "m.tiktok.com"],
    endpointHosts: ["www.tiktok.com", "tiktok.com"],
    frameHosts: ["www.tiktok.com"],
    thumbnailHosts: ["p16-sign.tiktokcdn-us.com", "p16-sign-va.tiktokcdn.com"],
    postPath: /^\/@[\w.-]+\/video\/\d+/,
  },
  reddit: {
    endpoint: "https://www.reddit.com/oembed",
    postHosts: ["www.reddit.com", "reddit.com", "old.reddit.com"],
    endpointHosts: ["www.reddit.com", "reddit.com"],
    frameHosts: ["www.redditmedia.com", "embed.reddit.com"],
    thumbnailHosts: ["preview.redd.it", "external-preview.redd.it", "i.redd.it"],
    postPath: /^\/r\/[\w-]+\/comments\/\w+/,
  },
};

export function providerFor(platform: Platform): Provider | undefined {
  return PROVIDERS[platform];
}

/** Why a platform has no embed, said plainly rather than left as a gap. */
export const NO_EMBED_REASON: Partial<Record<Platform, string>> = {
  github: "a GitHub profile has no post to embed",
  instagram: "Instagram's oEmbed has required an app token since 2020",
  web: "a website listing is a link, not a post",
};

/**
 * Query parameters stripped before a post URL becomes a cache key.
 *
 * Two people linking the same video through different campaigns must land on one
 * cache row, or the cache does nothing on the exact posts most likely to be
 * shared. Deliberately a deny-list of tracking parameters rather than an
 * allow-list: `v` on YouTube and `t` on a timestamped link are load-bearing.
 */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "igshid",
  "si",
  "feature",
  "share_id",
  "is_from_webapp",
  "sender_device",
  "ref",
  "ref_source",
  "share_source",
];

export class InvalidPostUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidPostUrlError";
  }
}

/**
 * Validate a submitted post URL and reduce it to its cache key.
 *
 * Throws rather than returning null, because the only caller that reaches it
 * with unvalidated input is checkout, which wants the reason to show the buyer.
 */
export function normalisePostUrl(platform: Platform, raw: string): string {
  const provider = providerFor(platform);
  if (!provider) {
    throw new InvalidPostUrlError(NO_EMBED_REASON[platform] ?? "this platform has no post embed");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidPostUrlError("That is not a URL.");
  }

  if (url.protocol !== "https:") {
    throw new InvalidPostUrlError("Must be a full https:// address.");
  }
  if (url.username || url.password) {
    throw new InvalidPostUrlError("Remove the credentials from the link.");
  }

  const host = url.hostname.toLowerCase();
  if (!provider.postHosts.includes(host)) {
    throw new InvalidPostUrlError(`That is not a ${provider.postHosts[0]} link.`);
  }

  // A profile URL is not a post. Without this the resolver would spend a request
  // learning what the pattern already knows.
  if (!provider.postPath.test(url.pathname)) {
    throw new InvalidPostUrlError("Link to a specific post, not to a profile.");
  }

  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  url.hash = "";
  url.hostname = host;
  // Sorted so two links differing only in parameter order share a cache row.
  url.searchParams.sort();

  return url.toString();
}

/** Non-throwing form, for the places that only need a yes or no. */
export function isValidPostUrl(platform: Platform, raw: string): boolean {
  try {
    normalisePostUrl(platform, raw);
    return true;
  } catch {
    return false;
  }
}
