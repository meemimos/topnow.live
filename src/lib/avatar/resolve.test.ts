import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { fetchBytes, type Transport } from "@/lib/fetch/net";
import { NO_RESOLVER_REASON, RESOLVERS, resolveAvatar } from "./resolve";

/**
 * Per-platform resolution (#19).
 *
 * Two things are being proved here. First, that a resolver never turns an
 * upstream problem into an exception — the payment path calls this, and a throw
 * there would mean a bad hour at GitHub costs a purchase. Second, that the
 * address gate is real: the loopback and private-range cases below run the
 * actual transport and the actual DNS path, not a stub.
 */

async function pngBytes(size = 200): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 5, g: 90, b: 120 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

function serving(bytes: Uint8Array): Transport {
  return async () => ({
    status: 200,
    location: null,
    body: (async function* one() {
      yield bytes;
    })(),
  });
}

describe("github", () => {
  it("resolves a handle into stored bytes", async () => {
    const outcome = await resolveAvatar("github", "mira-builds", {
      transport: serving(await pngBytes()),
    });

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.encoded.contentType).toBe("image/webp");
    expect(outcome.sourceUrl).toBe("https://github.com/mira-builds.png?size=156");
  });

  it("asks for the size it intends to store", async () => {
    const transport = vi.fn(serving(await pngBytes()));
    await resolveAvatar("github", "mira-builds", { transport });

    const requested = transport.mock.calls[0]![0];
    // 78px box at 2x. Asking for a thumbnail and enlarging it would be a blurry
    // avatar; asking for the full-size original would be wasted bytes.
    expect(requested.searchParams.get("size")).toBe("156");
  });

  it("allows the hop from github.com to the avatar CDN", async () => {
    const transport: Transport = async (url) =>
      url.hostname === "github.com"
        ? {
            status: 302,
            location: "https://avatars.githubusercontent.com/u/1?v=4",
            body: (async function* none() {})(),
          }
        : serving(await pngBytes())(url, new AbortController().signal);

    const outcome = await resolveAvatar("github", "mira-builds", { transport });
    expect(outcome.kind).toBe("resolved");
  });

  it("reports a 404 as a failure rather than throwing", async () => {
    const transport: Transport = async () => ({
      status: 404,
      location: null,
      body: (async function* none() {})(),
    });

    const outcome = await resolveAvatar("github", "nobody", { transport });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.reason).toContain("404");
  });

  it("treats non-image bytes as unavailable, not as something to retry", async () => {
    // Retrying will fetch the same not-an-image. Marking it failed would put it
    // back in the refresh queue forever.
    const transport = serving(new TextEncoder().encode("<html>nope</html>"));
    const outcome = await resolveAvatar("github", "mira-builds", { transport });
    expect(outcome.kind).toBe("unavailable");
  });

  it("refuses a handle the platform's own rules would reject", async () => {
    const transport = vi.fn<Transport>();
    // A leading hyphen is not a GitHub username. Checked again here because this
    // function is also reachable from the refresh job over older rows.
    const outcome = await resolveAvatar("github", "-nope-", { transport });

    expect(outcome.kind).toBe("unavailable");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["../../etc/passwd", "a/b", "a?x=1", "a#b", "a b"])(
    "refuses the path-shaped handle %s without fetching",
    async (handle) => {
      const transport = vi.fn<Transport>();
      const outcome = await resolveAvatar("github", handle, { transport });
      expect(outcome.kind).toBe("unavailable");
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe("platforms with no resolver", () => {
  it.each(["youtube", "instagram", "tiktok", "reddit", "web"] as const)(
    "%s is unavailable, and says why",
    async (platform) => {
      const transport = vi.fn<Transport>();
      const outcome = await resolveAvatar(platform, "someone", { transport });

      expect(outcome.kind).toBe("unavailable");
      if (outcome.kind === "unavailable") {
        expect(outcome.reason).toBe(NO_RESOLVER_REASON[platform]);
      }
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("has a stated reason for every platform it does not resolve", () => {
    const platforms = ["github", "youtube", "instagram", "tiktok", "reddit", "web"] as const;
    for (const platform of platforms) {
      const covered = Boolean(RESOLVERS[platform]) !== Boolean(NO_RESOLVER_REASON[platform]);
      expect(covered, `${platform} needs either a resolver or a reason, not both or neither`).toBe(
        true,
      );
    }
  });
});

describe("the allow-list is a list of hosts, never a shape", () => {
  it("never puts a handle anywhere near the host", () => {
    // The handle goes in the path. If it could reach the host, the resolver
    // would be an open proxy with a friendly interface.
    const url = new URL(RESOLVERS.github!.url("evil.example.com", 156));
    expect(url.hostname).toBe("github.com");
  });

  it("percent-encodes a handle into the path", () => {
    const url = new URL(RESOLVERS.github!.url("a/b", 156));
    expect(url.pathname).toBe("/a%2Fb.png");
  });
});

/**
 * The address gate, end to end.
 *
 * These use the real transport and the real DNS path — the only stub is the
 * allow-list, opened so the address check is what does the refusing. Nothing
 * leaves the machine: every target below resolves to an address the gate blocks,
 * which is the whole point.
 */
describe("SSRF targets are refused by the real fetch path", () => {
  const openAllowList = { isHostAllowed: () => true, timeoutMs: 3_000 };

  it.each([
    ["loopback by literal", "https://127.0.0.1/avatar.png", /loopback/],
    ["loopback by name", "https://localhost/avatar.png", /loopback/],
    ["private 10/8", "https://10.0.0.1/avatar.png", /private/],
    ["private 192.168/16", "https://192.168.1.1/avatar.png", /private/],
    ["private 172.16/12", "https://172.16.0.1/avatar.png", /private/],
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/", /link-local/],
    ["IPv6 loopback", "https://[::1]/avatar.png", /loopback/],
  ])("refuses %s", async (_label, url, reason) => {
    // Asserting on the *reason* rather than merely on rejection: a TLS or
    // connect error would also reject, and would mean the packet had already
    // gone out. Matching the classifier's own words is what proves it did not.
    await expect(fetchBytes(url, openAllowList)).rejects.toThrow(reason);
  });

  it("refuses an IP literal even though Node skips DNS for one", async () => {
    // Node only calls the `lookup` hook for names, so an address written as an
    // address bypasses it. The URL check is what closes that, and this is the
    // case that found it.
    await expect(
      fetchBytes("https://169.254.169.254/latest/meta-data/", openAllowList),
    ).rejects.toThrow(/Refused to fetch/);
  });
});
