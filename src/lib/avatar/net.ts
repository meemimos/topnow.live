import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { classifyAddress, classifyAddresses, parseIpv4, parseIpv6 } from "./addresses";
import { FETCH_TIMEOUT_MS, MAX_REDIRECTS, MAX_SOURCE_BYTES } from "./constants";

/**
 * The guarded fetch (#19).
 *
 * This is the one place in the product that makes an outbound request to a URL a
 * stranger influenced, so it is written as a gate rather than as a convenience:
 * https only, allow-listed host, every redirect re-checked, every resolved
 * address classified, a byte cap enforced while streaming, and a deadline on the
 * whole thing.
 *
 * ## Why `node:https` rather than `fetch`
 *
 * `https.request` accepts a `lookup` function, which lets the address that gets
 * *connected to* be the same address that was *checked*. Checking DNS separately
 * and then calling `fetch(hostname)` leaves a window in which the name can
 * resolve to something else — DNS rebinding is precisely the trick of answering
 * differently the second time. Global `fetch` gives no seam to close that window.
 */

export class BlockedRequestError extends Error {
  constructor(reason: string) {
    super(`Refused to fetch: ${reason}`);
    this.name = "BlockedRequestError";
  }
}

export type TransportResponse = {
  status: number;
  /** `Location`, only meaningful on a 3xx. */
  location: string | null;
  body: AsyncIterable<Uint8Array>;
};

/** The seam tests replace. The real one is `httpsTransport` below. */
export type Transport = (url: URL, signal: AbortSignal) => Promise<TransportResponse>;

/**
 * Node's declared `LookupFunction` insists on an address alongside the error,
 * while the runtime only ever reads one of the two. This is the shape the
 * runtime actually honours, and it is what lets the error path stay an error
 * rather than a fabricated address that something downstream might try to use.
 */
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Resolves a hostname and refuses to hand back any address that is not publicly
 * routable — including when a name answers with a mix of safe and unsafe ones.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const done = callback as LookupCallback;

  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      done(error);
      return;
    }

    const verdict = classifyAddresses(addresses.map((entry) => entry.address));
    if (!verdict.ok) {
      done(
        Object.assign(new Error(`blocked address for ${hostname}: ${verdict.reason}`), {
          code: "EBLOCKED",
        }),
      );
      return;
    }

    // `all: true` was requested above so that every answer could be checked;
    // the caller still gets the shape it asked for.
    if (options.all) {
      done(null, addresses);
      return;
    }
    const first = addresses[0]!;
    done(null, first.address, first.family);
  });
};

/** The real transport: one request, no automatic redirect following. */
export const httpsTransport: Transport = (url, signal) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        signal,
        // Never follow a redirect inside the client — each hop is re-checked
        // against the allow-list by the caller instead.
        lookup: guardedLookup,
        headers: {
          // Named honestly. A resolver that disguises itself is a resolver
          // whose traffic cannot be blocked by a host that wants it blocked.
          "user-agent": "TopNow-Avatar/1.0 (+https://topnow.live)",
          accept: "image/png,image/jpeg,image/webp,image/gif;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
        },
      },
      (response) => {
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          location: typeof location === "string" ? location : null,
          body: response,
        });
      },
    );

    request.on("error", reject);
    request.end();
  });

/**
 * Reads a body with a hard ceiling.
 *
 * The cap is applied to bytes actually received, not to `Content-Length`: a
 * hostile server is free to declare any length it likes, and the declaration is
 * not what fills memory.
 */
async function readCapped(body: AsyncIterable<Uint8Array>, cap: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > cap) {
      throw new BlockedRequestError(`response exceeded ${cap} bytes`);
    }
    chunks.push(chunk);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type FetchOptions = {
  /** The allow-list. A host not on it is refused before any packet is sent. */
  isHostAllowed: (host: string) => boolean;
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export type FetchedBytes = { bytes: Uint8Array; finalUrl: string };

/**
 * The hostname as an IP address, when it is written as one.
 *
 * `URL.hostname` keeps the brackets on an IPv6 literal, so they come off here.
 */
function literalAddress(hostname: string): string | null {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return parseIpv4(bare) || parseIpv6(bare) ? bare : null;
}

function checkUrl(raw: string, isHostAllowed: (host: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedRequestError(`${raw} is not a URL`);
  }

  // http: would be downgradeable in transit, and every other scheme (file:,
  // gopher:, data:) is a different attack rather than a different protocol.
  if (url.protocol !== "https:") {
    throw new BlockedRequestError(`${url.protocol} is not https`);
  }
  // Credentials in the URL would be sent to the host; a handle-derived URL has
  // no business carrying any.
  if (url.username || url.password) {
    throw new BlockedRequestError("URL carries credentials");
  }
  // An IP literal never reaches `guardedLookup`: Node skips DNS entirely when
  // the host is already an address, so the hook that classifies addresses is
  // never called. Without this branch a redirect to https://169.254.169.254/
  // would be connected to. Found by the test that fires exactly that URL at the
  // real transport.
  const literal = literalAddress(url.hostname);
  if (literal) {
    const verdict = classifyAddress(literal);
    if (!verdict.ok) throw new BlockedRequestError(verdict.reason);
  }

  if (!isHostAllowed(url.hostname)) {
    throw new BlockedRequestError(`${url.hostname} is not an allowed host`);
  }
  return url;
}

/**
 * Fetch an image, or refuse.
 *
 * Redirects are followed manually so that each hop passes the same gate as the
 * first. A redirect to an allow-listed host is fine — GitHub's avatar URL is
 * genuinely one host handing off to another — but a redirect *off* the list is
 * the exact move this function exists to stop.
 */
export async function fetchImageBytes(
  startUrl: string,
  options: FetchOptions,
): Promise<FetchedBytes> {
  const {
    isHostAllowed,
    transport = httpsTransport,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_SOURCE_BYTES,
    maxRedirects = MAX_REDIRECTS,
  } = options;

  const controller = new AbortController();
  // One deadline for the whole chain, not per hop: three hops each just inside a
  // per-hop timeout is a slow-loris budget rather than a limit.
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = checkUrl(startUrl, isHostAllowed);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await transport(url, controller.signal);

      if (response.status >= 300 && response.status < 400) {
        if (!response.location) {
          throw new BlockedRequestError(`${response.status} with no location`);
        }
        if (hop === maxRedirects) {
          throw new BlockedRequestError(`more than ${maxRedirects} redirects`);
        }
        // Resolved against the current URL, because a Location may be relative.
        url = checkUrl(new URL(response.location, url).toString(), isHostAllowed);
        continue;
      }

      if (response.status !== 200) {
        throw new BlockedRequestError(`upstream returned ${response.status}`);
      }

      const bytes = await readCapped(response.body, maxBytes);
      return { bytes, finalUrl: url.toString() };
    }

    throw new BlockedRequestError(`more than ${maxRedirects} redirects`);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BlockedRequestError(`timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
