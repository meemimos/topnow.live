import sharp from "sharp";

import { AVATAR_SIZES, AVATAR_SCALE, STORED_CONTENT_TYPE, storedPixels } from "./constants";
import type { AvatarSize } from "./constants";

/**
 * Turning downloaded bytes into something safe to serve (#19).
 *
 * Two rules, both from the issue:
 *
 * **Content decides what a file is, never its headers.** `Content-Type` and the
 * URL's extension are both attacker-influenced. An HTML document served as
 * `image/png` is a stored XSS if it is ever handed back with a content type a
 * browser will render, so the magic bytes are the only opinion that counts.
 *
 * **Re-encode, never store the original.** Passing the upstream bytes through
 * would carry EXIF (including GPS), colour profiles, trailing appended data, and
 * any parser bug in whatever decodes it later. Decoding and re-encoding produces
 * a file this codebase wrote, whose provenance is the pixels alone.
 */

/** Magic-byte signatures for the formats worth accepting as an avatar. */
const SIGNATURES: ReadonlyArray<{ format: string; test: (bytes: Uint8Array) => boolean }> = [
  {
    format: "png",
    test: (b) =>
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  { format: "jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { format: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    format: "webp",
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/**
 * SVG is deliberately absent from the list above.
 *
 * It is a document format that can carry script and external references, and
 * every platform that serves one also serves a raster alternative. Refusing it
 * costs nothing and removes a whole class of problem.
 */
export function sniffImageFormat(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  return SIGNATURES.find((signature) => signature.test(bytes))?.format ?? null;
}

export class NotAnImageError extends Error {
  constructor(detail: string) {
    super(`Downloaded bytes are not a usable image: ${detail}`);
    this.name = "NotAnImageError";
  }
}

export type EncodedAvatar = { [K in AvatarSize]: Uint8Array<ArrayBuffer> } & {
  contentType: string;
  /** The format that came in. Recorded to make a resolution log readable. */
  sourceFormat: string;
};

/**
 * Decode once, emit both stored sizes.
 *
 * Both come from the same decode rather than from two passes over the source, so
 * a file that decodes inconsistently cannot produce a large and a small avatar
 * that disagree.
 *
 * `failOn: "error"` makes sharp refuse a truncated or malformed file instead of
 * doing its best with it — a partially decoded avatar is a corrupt one, and
 * "best effort" on hostile input is how a decoder gets walked off the end of a
 * buffer.
 */
export async function encodeAvatar(source: Uint8Array): Promise<EncodedAvatar> {
  const sourceFormat = sniffImageFormat(source);
  if (!sourceFormat) throw new NotAnImageError("no recognised image signature");

  const buffer = Buffer.from(source);

  const render = async (size: AvatarSize): Promise<Uint8Array<ArrayBuffer>> => {
    const pixels = storedPixels(size);
    const encoded = await sharp(buffer, { failOn: "error", animated: false })
      .resize(pixels, pixels, { fit: "cover", position: "centre", withoutEnlargement: false })
      // `force` because the input may already be webp and we still want our
      // encoder's output, not a passthrough of the original container.
      .webp({ quality: 82, effort: 4, force: true })
      // Metadata is dropped by default; saying so is the point of the comment
      // rather than of a call, and re-encoding is what actually strips it.
      .toBuffer();
    // Copied into a plain Uint8Array over its own ArrayBuffer. A Node Buffer is
    // a view into a shared pool, so handing one straight to the database driver
    // hands over a window onto bytes that belong to something else.
    return new Uint8Array(encoded);
  };

  let large: Uint8Array<ArrayBuffer>;
  let small: Uint8Array<ArrayBuffer>;
  try {
    [large, small] = await Promise.all([render("large"), render("small")]);
  } catch (error) {
    throw new NotAnImageError(
      `${sourceFormat} decode failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  return { large, small, contentType: STORED_CONTENT_TYPE, sourceFormat };
}

/** The pixel dimensions actually stored, for the log line and for tests. */
export const STORED_DIMENSIONS = {
  large: AVATAR_SIZES.large * AVATAR_SCALE,
  small: AVATAR_SIZES.small * AVATAR_SCALE,
} as const;
