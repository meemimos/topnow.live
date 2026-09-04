import { describe, expect, it, vi } from "vitest";

import { BlockedRequestError, fetchBytes, type Transport } from "./net";

/**
 * The guarded fetch (#19).
 *
 * The transport is injected rather than reached for over the network: the
 * behaviour under test is the *gate* — what it refuses, and how much of a
 * response it is willing to read — and a test that needs a live host to prove a
 * refusal is a test that goes red when someone else has an outage.
 */

const ALLOWED = ["images.example.com", "cdn.example.com"];
const isHostAllowed = (host: string) => ALLOWED.includes(host);

function bodyOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* stream() {
    for (const chunk of chunks) yield chunk;
  })();
}

function respondWith(bytes: Uint8Array): Transport {
  return async () => ({ status: 200, location: null, body: bodyOf(bytes) });
}

const PAYLOAD = new Uint8Array([1, 2, 3, 4]);

describe("what it refuses before sending anything", () => {
  it("refuses a host that is not on the allow-list", async () => {
    const transport = vi.fn<Transport>();
    await expect(
      fetchBytes("https://evil.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(BlockedRequestError);
    // The point: nothing was sent. A refusal after the request is not a refusal.
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "http://images.example.com/a.png",
    "file:///etc/passwd",
    "gopher://images.example.com/",
    "data:image/png;base64,AAAA",
  ])("refuses %s", async (url) => {
    const transport = vi.fn<Transport>();
    await expect(fetchBytes(url, { isHostAllowed, transport })).rejects.toThrow(
      BlockedRequestError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a URL carrying credentials", async () => {
    const transport = vi.fn<Transport>();
    await expect(
      fetchBytes("https://user:pw@images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(/credentials/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses something that is not a URL at all", async () => {
    await expect(fetchBytes("not a url", { isHostAllowed })).rejects.toThrow(BlockedRequestError);
  });
});

describe("redirects", () => {
  it("follows a hop to another allow-listed host", async () => {
    // GitHub genuinely does this: github.com issues the redirect and
    // avatars.githubusercontent.com serves the bytes.
    const transport: Transport = async (url) =>
      url.hostname === "images.example.com"
        ? { status: 302, location: "https://cdn.example.com/a.png", body: bodyOf() }
        : { status: 200, location: null, body: bodyOf(PAYLOAD) };

    const result = await fetchBytes("https://images.example.com/a.png", {
      isHostAllowed,
      transport,
    });
    expect(result.bytes).toEqual(PAYLOAD);
    expect(result.finalUrl).toBe("https://cdn.example.com/a.png");
  });

  it("refuses a hop to a host that is not on the allow-list", async () => {
    const transport: Transport = async () => ({
      status: 302,
      location: "https://evil.example.com/a.png",
      body: bodyOf(),
    });

    await expect(
      fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(/not an allowed host/);
  });

  it("refuses a hop to the cloud metadata address", async () => {
    // The redirect is the interesting vector: the first URL looks entirely
    // ordinary, and the address only appears in the response.
    const transport: Transport = async () => ({
      status: 302,
      location: "https://169.254.169.254/latest/meta-data/",
      body: bodyOf(),
    });

    await expect(
      fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(/link-local/);
  });

  it("resolves a relative Location against the current URL", async () => {
    const seen: string[] = [];
    const transport: Transport = async (url) => {
      seen.push(url.toString());
      return url.pathname === "/a.png"
        ? { status: 301, location: "/b.png", body: bodyOf() }
        : { status: 200, location: null, body: bodyOf(PAYLOAD) };
    };

    await fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport });
    expect(seen).toEqual(["https://images.example.com/a.png", "https://images.example.com/b.png"]);
  });

  it("gives up rather than looping forever", async () => {
    const transport: Transport = async () => ({
      status: 302,
      location: "https://images.example.com/again.png",
      body: bodyOf(),
    });

    await expect(
      fetchBytes("https://images.example.com/a.png", {
        isHostAllowed,
        transport,
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/more than 2 redirects/);
  });

  it("abandons a redirect's body instead of leaving its socket open", async () => {
    // Node keeps the connection alive for reuse, and a response whose body is
    // never consumed holds its socket until the agent times out. GitHub's
    // avatar URL always redirects, so without this it was one leaked socket per
    // resolution.
    const cancelled: number[] = [];
    const transport: Transport = async (url) => ({
      status: url.pathname === "/a.png" ? 302 : 200,
      location: url.pathname === "/a.png" ? "https://cdn.example.com/b.png" : null,
      body: bodyOf(PAYLOAD),
      cancel: () => cancelled.push(1),
    });

    await fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport });
    // Exactly the redirect, and not the response that was actually read.
    expect(cancelled).toHaveLength(1);
  });

  it("abandons an error body too", async () => {
    let cancelled = 0;
    const transport: Transport = async () => ({
      status: 500,
      location: null,
      body: bodyOf(PAYLOAD),
      cancel: () => {
        cancelled += 1;
      },
    });

    await expect(
      fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(/returned 500/);
    expect(cancelled).toBe(1);
  });

  it("refuses a 3xx with no Location rather than treating it as a body", async () => {
    const transport: Transport = async () => ({ status: 302, location: null, body: bodyOf() });
    await expect(
      fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(/no location/);
  });
});

describe("the byte cap", () => {
  it("stops reading once the cap is passed", async () => {
    const chunk = new Uint8Array(64);
    let yielded = 0;
    const transport: Transport = async () => ({
      status: 200,
      location: null,
      body: (async function* endless() {
        // A server that never stops sending. The cap is what ends this, not the
        // server's good manners.
        for (;;) {
          yielded += 1;
          yield chunk;
        }
      })(),
    });

    await expect(
      fetchBytes("https://images.example.com/a.png", {
        isHostAllowed,
        transport,
        maxBytes: 256,
      }),
    ).rejects.toThrow(/exceeded 256 bytes/);

    // Proof the cap is on bytes received rather than on a declared length: the
    // stream was cut off after a handful of chunks, not drained.
    expect(yielded).toBeLessThan(10);
  });

  it("accepts a body exactly at the cap", async () => {
    const bytes = new Uint8Array(256).fill(7);
    const result = await fetchBytes("https://images.example.com/a.png", {
      isHostAllowed,
      transport: respondWith(bytes),
      maxBytes: 256,
    });
    expect(result.bytes.byteLength).toBe(256);
  });

  it("reassembles a body that arrives in pieces", async () => {
    const transport: Transport = async () => ({
      status: 200,
      location: null,
      body: bodyOf(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4])),
    });

    const result = await fetchBytes("https://images.example.com/a.png", {
      isHostAllowed,
      transport,
    });
    expect(result.bytes).toEqual(PAYLOAD);
  });
});

describe("failures", () => {
  it.each([404, 403, 500, 503])("refuses a %d", async (status) => {
    const transport: Transport = async () => ({ status, location: null, body: bodyOf() });
    await expect(
      fetchBytes("https://images.example.com/a.png", { isHostAllowed, transport }),
    ).rejects.toThrow(new RegExp(`returned ${status}`));
  });

  it("reports a timeout as a timeout", async () => {
    // A transport that respects the signal, which is what a real one does.
    const transport: Transport = (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    await expect(
      fetchBytes("https://images.example.com/a.png", {
        isHostAllowed,
        transport,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("applies one deadline to the whole redirect chain", async () => {
    // Each hop is individually fast; together they are not. A per-hop timeout
    // would let this run forever.
    const transport: Transport = async (_url, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (signal.aborted) throw new Error("aborted");
      return { status: 302, location: "https://cdn.example.com/next.png", body: bodyOf() };
    };

    await expect(
      fetchBytes("https://images.example.com/a.png", {
        isHostAllowed,
        transport,
        timeoutMs: 25,
        maxRedirects: 10,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
