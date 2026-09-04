import type { AvatarSize } from "@/lib/avatar/constants";
import { avatarBox, avatarSrc } from "@/lib/avatar/url";
import type { BoardAvatar } from "@/lib/avatar/store";
import { cn } from "@/lib/utils";

/** The diagonal hatch, from tokens — the stripe pitch is the only difference. */
const HATCH_LARGE =
  "bg-[repeating-linear-gradient(135deg,var(--color-hatch-dark)_0_5px,var(--color-hatch-light)_5px_10px)]";
const HATCH_SMALL =
  "bg-[repeating-linear-gradient(135deg,var(--color-hatch-dark)_0_4px,var(--color-hatch-light)_4px_8px)]";

const BOX = {
  large: "text-2xs h-[78px] w-[78px] leading-normal",
  small: "h-[38px] w-[38px]",
} as const satisfies Record<AvatarSize, string>;

const FRAME = "shrink-0 border-[3px] border-ridge";

/**
 * The avatar placeholder.
 *
 * A designed state, not a broken image — and it is what every failure mode
 * degrades to (#19): no resolver for the platform, a handle with no avatar, a
 * fetch that timed out, or a website listing, which has no avatar concept at
 * all. Identical in every case on purpose: the board is not the place to explain
 * why a third party did not answer.
 */
export function AvatarPlaceholder({ size, className }: { size: AvatarSize; className?: string }) {
  return (
    <div
      className={cn(
        FRAME,
        "flex items-center justify-center text-center font-pixel text-ink-soft",
        BOX[size],
        size === "large" ? HATCH_LARGE : HATCH_SMALL,
        className,
      )}
      aria-hidden="true"
    />
  );
}

/**
 * A listing's avatar: TopNow's own copy, or the placeholder.
 *
 * `src` is always same-origin. Nothing on the board ever points at a
 * third-party image host, which is what keeps a visitor's IP from reaching
 * GitHub because they looked at a leaderboard.
 *
 * Decorative rather than described: the handle sits next to it as text, so an
 * alt string would only repeat what a screen reader has already reached. Sized
 * in the markup so the row does not reflow when the image lands.
 */
export function Avatar({
  avatar,
  size,
  className,
}: {
  avatar: BoardAvatar | undefined;
  size: AvatarSize;
  className?: string;
}) {
  if (!avatar) return <AvatarPlaceholder size={size} className={className} />;

  const box = avatarBox(size);

  return (
    /* These bytes are already resized and re-encoded to exactly the rendered
       size by #19's own pipeline, and served from our own route. next/image
       would put a second optimiser in front of our own output, for an image
       whose dimensions are fixed and known at build time. */
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarSrc(avatar, size)}
      alt=""
      width={box}
      height={box}
      decoding="async"
      loading="eager"
      className={cn(FRAME, "block object-cover", BOX[size], className)}
    />
  );
}
