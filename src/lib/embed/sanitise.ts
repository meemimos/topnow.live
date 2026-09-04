/**
 * What survives contact with a provider's oEmbed response (#20).
 *
 * An oEmbed `html` field is third-party markup. The issue says to sanitise and
 * sandbox it; this file takes the stronger line available, which is **not to
 * keep the markup at all**.
 *
 * What is kept instead is the one thing the markup is for: the URL its iframe
 * points at. Everything else — attributes, sibling script tags, inline styles,
 * whatever a compromised or creative provider decides to return — is discarded
 * rather than filtered. A sanitiser is a list of things you thought of; an
 * extractor is a list of things you want. On markup from outside the product,
 * the second is the one worth writing.
 *
 * The extracted URL is then rendered by our own component, with our own sandbox
 * attributes, so the provider cannot influence the frame's permissions.
 */

export type ExtractedFrame = {
  src: string;
  width: number | null;
  height: number | null;
};

/** Reads one HTML attribute out of a tag, single or double quoted. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? null) : null;
}

function positiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : null;
}

export class UnusableEmbedHtmlError extends Error {
  constructor(reason: string) {
    super(`Embed HTML is unusable: ${reason}`);
    this.name = "UnusableEmbedHtmlError";
  }
}

/**
 * Pull the iframe URL out of a provider's HTML.
 *
 * Refuses anything that is not exactly one iframe. A response carrying two
 * frames, or a frame plus a script, is not a shape this product has a rendering
 * for — and "take the first one and ignore the rest" is how a script tag ends up
 * quietly retained next to it.
 */
export function extractFrame(
  html: string,
  isFrameHostAllowed: (host: string) => boolean,
): ExtractedFrame {
  if (html.length > 20_000) throw new UnusableEmbedHtmlError("response html is implausibly large");

  // TikTok and Reddit both return a <blockquote> plus a <script> that swaps it
  // for a frame at runtime. That script would run in our page's context, which
  // is exactly what must not happen — so a response with no iframe of its own is
  // refused rather than "enhanced".
  const iframes = html.match(/<iframe\b[^>]*>/gi) ?? [];
  if (iframes.length === 0) throw new UnusableEmbedHtmlError("no iframe in the response");
  if (iframes.length > 1) throw new UnusableEmbedHtmlError("more than one iframe in the response");

  const tag = iframes[0]!;
  const rawSrc = attribute(tag, "src");
  if (!rawSrc) throw new UnusableEmbedHtmlError("iframe has no src");

  // Providers routinely return a protocol-relative src. Resolved to https
  // explicitly rather than left for a browser to guess.
  const candidate = rawSrc.startsWith("//") ? `https:${rawSrc}` : rawSrc;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new UnusableEmbedHtmlError("iframe src is not an absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new UnusableEmbedHtmlError(`iframe src is ${url.protocol}, not https`);
  }
  if (!isFrameHostAllowed(url.hostname.toLowerCase())) {
    // A provider redirecting its own embed to a host we do not expect is either
    // a change worth noticing or a compromise worth refusing. Either way, not
    // something to render.
    throw new UnusableEmbedHtmlError(`iframe host ${url.hostname} is not allowed`);
  }

  return {
    src: url.toString(),
    width: positiveInt(attribute(tag, "width")),
    height: positiveInt(attribute(tag, "height")),
  };
}

/**
 * Provider-supplied text, reduced to text.
 *
 * React escapes on render, so this is not about injection — it is about a title
 * that is four kilobytes of whitespace, or that carries newlines into a row
 * built for one line.
 */
export function plainText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * A count from a provider, or nothing.
 *
 * Anything that is not a plain non-negative integer becomes `null`, and a null
 * count is omitted from the footer rather than rendered as zero. "We do not
 * know" and "nobody watched it" are different claims.
 */
export function providerCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}
