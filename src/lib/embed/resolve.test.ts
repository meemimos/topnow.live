import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import type { Transport, TransportResponse } from "@/lib/fetch/net";

import { PROVIDERS } from "./providers";
import { oembedUrl, resolveEmbed } from "./resolve";

/**
 * Resolving a post (#20).
 *
 * The acceptance this file exists for: **a test forces every failure mode —
 * timeout, 404, malformed response, deleted post — and the caller is left with
 * nothing renderable each time.** `resolveEmbed` never throws, so "nothing
 * renderable" is a return value the board can branch on rather than an exception
 * somewhere up the payment path.
 */

const POST = "https://www.youtube.com/watch?v=abc123";

const GOOD_HTML =
  '<iframe width="200" height="113" src="https://www.youtube.com/embed/abc123" ' +
  'frameborder="0" allowfullscreen></iframe>';

function body(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* one() {
    yield bytes;
  })();
}

function json(payload: unknown): TransportResponse {
  return {
    status: 200,
    location: null,
    body: body(new TextEncoder().encode(JSON.stringify(payload))),
  };
}

async function jpegBytes(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: 480, height: 270, channels: 3, background: { r: 30, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

/**
 * One transport for both calls, branching on host — the oEmbed endpoint and the
 * thumbnail CDN are different hosts, which is what makes this readable.
 */
function transportFor(
  payload: unknown,
  options: { thumbnail?: Uint8Array | "fail" } = {},
): Transport {
  return async (url) => {
    if (url.hostname === "i.ytimg.com") {
      if (options.thumbnail === "fail" || !options.thumbnail) {
        return { status: 404, location: null, body: body(new Uint8Array()) };
      }
      return { status: 200, location: null, body: body(options.thumbnail) };
    }
    return json(payload);
  };
}

const FULL_PAYLOAD = {
  html: GOOD_HTML,
  title: "Open-source invoicing, explained",
  author_name: "parcelkit",
  thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
};

describe("a post that resolves", () => {
  it("keeps the title, the author and the frame", async () => {
    const outcome = await resolveEmbed("youtube", POST, {
      transport: transportFor(FULL_PAYLOAD, { thumbnail: await jpegBytes() }),
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.embed.title).toBe("Open-source invoicing, explained");
    expect(outcome.embed.authorName).toBe("parcelkit");
    expect(outcome.embed.iframeSrc).toBe("https://www.youtube.com/embed/abc123");
    expect(outcome.embed.iframeWidth).toBe(200);
  });

  it("stores its own re-encoded copy of the thumbnail", async () => {
    const outcome = await resolveEmbed("youtube", POST, {
      transport: transportFor(FULL_PAYLOAD, { thumbnail: await jpegBytes() }),
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    // Ours, not the provider's bytes: webp, at the width the media area renders.
    const meta = await sharp(Buffer.from(outcome.embed.thumbnail!)).metadata();
    expect(meta.format).toBe("webp");
    expect(outcome.embed.thumbnailWidth).toBe(640);
  });

  it("resolves without a thumbnail rather than failing the whole embed", async () => {
    const outcome = await resolveEmbed("youtube", POST, {
      transport: transportFor(FULL_PAYLOAD, { thumbnail: "fail" }),
    });

    // A title, an author and a frame is a renderable panel. Losing it because a
    // CDN was slow would cost slot 01 its panel for no reason.
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.embed.thumbnail).toBeNull();
  });

  it("refuses a thumbnail that is not an image", async () => {
    const notAnImage = new TextEncoder().encode("<html>gotcha</html>");
    const outcome = await resolveEmbed("youtube", POST, {
      transport: transportFor(FULL_PAYLOAD, { thumbnail: notAnImage }),
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.embed.thumbnail).toBeNull();
  });

  it("never fetches a thumbnail from a host outside the provider's own CDN", async () => {
    const transport = vi.fn<Transport>(async (url) => {
      if (url.hostname !== "www.youtube.com") throw new Error("should not have been fetched");
      return json({ ...FULL_PAYLOAD, thumbnail_url: "https://evil.example.com/pixel.png" });
    });

    const outcome = await resolveEmbed("youtube", POST, { transport });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.embed.thumbnail).toBeNull();
  });

  it("reports views only when the provider actually sent a number", async () => {
    const without = await resolveEmbed("youtube", POST, { transport: transportFor(FULL_PAYLOAD) });
    expect(without.kind === "resolved" && without.embed.providerViews).toBeNull();

    const withCount = await resolveEmbed("youtube", POST, {
      transport: transportFor({ ...FULL_PAYLOAD, view_count: 4126 }),
    });
    expect(withCount.kind === "resolved" && withCount.embed.providerViews).toBe(4126);
  });
});

/**
 * Every failure mode the issue names, plus the ones a provider can invent.
 * None of them throws, and none of them produces something renderable.
 */
describe("every failure mode", () => {
  it("a 404 is settled, not retried forever", async () => {
    const transport: Transport = async () => ({
      status: 404,
      location: null,
      body: body(new Uint8Array()),
    });

    const outcome = await resolveEmbed("youtube", POST, { transport });
    // A deleted post stays deleted. Marking it `failed` would put it back in the
    // refresh queue on every cycle, forever.
    expect(outcome.kind).toBe("unavailable");
  });

  it.each([401, 403, 410])("a %d is settled too", async (status) => {
    const transport: Transport = async () => ({
      status,
      location: null,
      body: body(new Uint8Array()),
    });
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("unavailable");
  });

  it("a 500 is worth asking again about", async () => {
    const transport: Transport = async () => ({
      status: 500,
      location: null,
      body: body(new Uint8Array()),
    });
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("failed");
  });

  it("a timeout is a failure, not an exception", async () => {
    const transport: Transport = (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const outcome = await resolveEmbed("youtube", POST, { transport });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toMatch(/timed out/);
  });

  it("malformed JSON is settled rather than retried", async () => {
    const transport: Transport = async () => ({
      status: 200,
      location: null,
      body: body(new TextEncoder().encode("<!DOCTYPE html><html>not json</html>")),
    });
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("unavailable");
  });

  it("a JSON array instead of an object is refused", async () => {
    const transport: Transport = async () => json([1, 2, 3]);
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("unavailable");
  });

  it("a response with no html is refused", async () => {
    const transport: Transport = async () => json({ title: "no frame here" });
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("unavailable");
  });

  it("a response whose html has no iframe is refused", async () => {
    const transport: Transport = async () =>
      json({ html: '<blockquote></blockquote><script src="https://x/e.js"></script>' });
    expect((await resolveEmbed("youtube", POST, { transport })).kind).toBe("unavailable");
  });

  it("a frame pointing somewhere unexpected is refused", async () => {
    const transport: Transport = async () =>
      json({ html: '<iframe src="https://evil.example.com/x"></iframe>' });

    const outcome = await resolveEmbed("youtube", POST, { transport });
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind === "unavailable") expect(outcome.reason).toMatch(/not allowed/);
  });

  it.each(["github", "instagram", "web"] as const)(
    "%s has no provider and is never asked",
    async (platform) => {
      const transport = vi.fn<Transport>();
      const outcome = await resolveEmbed(platform, POST, { transport });

      expect(outcome.kind).toBe("unavailable");
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe("the oEmbed request", () => {
  it("puts the post in a query parameter of our endpoint, never in the host", () => {
    const url = new URL(oembedUrl(PROVIDERS.youtube!, "https://evil.example.com/x"));
    expect(url.hostname).toBe("www.youtube.com");
    expect(url.searchParams.get("url")).toBe("https://evil.example.com/x");
  });

  it("asks for json explicitly", () => {
    const url = new URL(oembedUrl(PROVIDERS.youtube!, POST));
    expect(url.searchParams.get("format")).toBe("json");
  });
});
