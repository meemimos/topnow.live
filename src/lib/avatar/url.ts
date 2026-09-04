import { AVATAR_SIZES, AVATAR_SCALE } from "./constants";
import type { AvatarSize } from "./constants";

/**
 * Where the board points an `<img>` at (#19).
 *
 * Shared by the components and the route so the two cannot drift into
 * disagreeing about the shape of a URL. Safe to import from a client component:
 * nothing here touches the database.
 */

export function avatarSrc(avatar: { id: string; version: number }, size: AvatarSize): string {
  return `/api/avatar/${avatar.id}/${size}?v=${avatar.version}`;
}

/** The `width`/`height` attributes — the CSS box, not the stored pixels. */
export function avatarBox(size: AvatarSize): number {
  return AVATAR_SIZES[size];
}

export function isAvatarSize(value: string): value is AvatarSize {
  return value === "large" || value === "small";
}

/** The intrinsic size of the stored file, for `sizes`/`srcset` reasoning. */
export function avatarIntrinsic(size: AvatarSize): number {
  return AVATAR_SIZES[size] * AVATAR_SCALE;
}
