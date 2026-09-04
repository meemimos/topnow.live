import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { STORED_DIMENSIONS, encodeAvatar, sniffImageFormat, NotAnImageError } from "./image";

/**
 * Validation and re-encoding (#19).
 *
 * The fixtures are generated rather than checked in, because what matters is
 * that a *real* encoded image of each accepted format survives the pipeline and
 * that everything else is refused — not that one particular file does.
 */

async function makeImage(format: "png" | "jpeg" | "webp" | "gif", size = 300): Promise<Uint8Array> {
  const base = sharp({
    create: { width: size, height: size, channels: 3, background: { r: 200, g: 40, b: 90 } },
  });
  const encoded = await (
    format === "png"
      ? base.png()
      : format === "jpeg"
        ? base.jpeg()
        : format === "webp"
          ? base.webp()
          : base.gif()
  ).toBuffer();
  return new Uint8Array(encoded);
}

describe("sniffImageFormat", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("recognises a real %s", async (format) => {
    expect(sniffImageFormat(await makeImage(format))).toBe(format);
  });

  it("does not believe a content type or an extension", async () => {
    // The whole point: this is what an "avatar.png" served as image/png can
    // actually contain. Only the bytes get a vote.
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    expect(sniffImageFormat(html)).toBeNull();
  });

  it.each([
    ["an SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
    ["a PDF", "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"],
    ["a zip", "PKaaaaaaaaaaaa"],
    ["a shell script", "#!/bin/sh\necho hi\n"],
  ])("refuses %s", (_name, text) => {
    expect(sniffImageFormat(new TextEncoder().encode(text))).toBeNull();
  });

  it("refuses something too short to have a signature", () => {
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  /**
   * SVG is refused deliberately, not by omission: it is a document format that
   * can carry script, and every platform that serves one also serves a raster.
   */
  it("refuses an SVG even with an XML declaration in front of it", () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>';
    expect(sniffImageFormat(new TextEncoder().encode(svg))).toBeNull();
  });
});

describe("encodeAvatar", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("re-encodes a %s to webp", async (format) => {
    const encoded = await encodeAvatar(await makeImage(format));
    expect(encoded.contentType).toBe("image/webp");
    expect(encoded.sourceFormat).toBe(format);
    // The output is our encoder's, never a passthrough of the input container.
    expect(sniffImageFormat(encoded.large)).toBe("webp");
    expect(sniffImageFormat(encoded.small)).toBe("webp");
  });

  it("emits exactly the two sizes the board renders", async () => {
    const encoded = await encodeAvatar(await makeImage("png"));

    const large = await sharp(Buffer.from(encoded.large)).metadata();
    const small = await sharp(Buffer.from(encoded.small)).metadata();

    // 78px and 38px boxes at 2x. The browser is never asked to scale one down.
    expect([large.width, large.height]).toEqual([STORED_DIMENSIONS.large, STORED_DIMENSIONS.large]);
    expect([small.width, small.height]).toEqual([STORED_DIMENSIONS.small, STORED_DIMENSIONS.small]);
  });

  it("enlarges a source smaller than the box rather than serving a tiny image", async () => {
    const encoded = await encodeAvatar(await makeImage("png", 20));
    const large = await sharp(Buffer.from(encoded.large)).metadata();
    expect(large.width).toBe(STORED_DIMENSIONS.large);
  });

  it("crops a non-square source to a square rather than squashing it", async () => {
    const wide = await sharp({
      create: { width: 400, height: 100, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();

    const encoded = await encodeAvatar(new Uint8Array(wide));
    const large = await sharp(Buffer.from(encoded.large)).metadata();
    expect(large.width).toBe(large.height);
  });

  it("strips metadata by re-encoding", async () => {
    const withExif = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD0: { Copyright: "somebody else", Software: "not us" } })
      .jpeg()
      .toBuffer();

    // The fixture really does carry it, or this test proves nothing.
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const encoded = await encodeAvatar(new Uint8Array(withExif));
    expect((await sharp(Buffer.from(encoded.large)).metadata()).exif).toBeUndefined();
  });

  it("refuses bytes that are not an image", async () => {
    const html = new TextEncoder().encode("<html><body>not an avatar</body></html>");
    await expect(encodeAvatar(html)).rejects.toThrow(NotAnImageError);
  });

  it("refuses a file with a valid signature and a corrupt body", async () => {
    // A truncated PNG sniffs as a PNG. `failOn: "error"` is what stops the
    // decoder doing its best with it and producing half an avatar.
    const png = await makeImage("png");
    await expect(encodeAvatar(png.slice(0, 60))).rejects.toThrow(NotAnImageError);
  });

  it("does not carry the source bytes through into the output", async () => {
    const source = await makeImage("png");
    const encoded = await encodeAvatar(source);
    expect(Buffer.from(encoded.large).equals(Buffer.from(source))).toBe(false);
  });
});
