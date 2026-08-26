import { cn } from "@/lib/utils";

/** The diagonal hatch, from tokens — the stripe pitch is the only difference. */
const HATCH_LARGE =
  "bg-[repeating-linear-gradient(135deg,var(--color-hatch-dark)_0_5px,var(--color-hatch-light)_5px_10px)]";
const HATCH_SMALL =
  "bg-[repeating-linear-gradient(135deg,var(--color-hatch-dark)_0_4px,var(--color-hatch-light)_4px_8px)]";

/**
 * The avatar placeholder.
 *
 * A designed state, not a broken image. Server-side avatar resolution is #19;
 * until then every listing renders this, and after #19 it remains what a failed
 * or absent resolution degrades to — a website listing has no avatar concept at
 * all and uses it by design.
 */
export function AvatarPlaceholder({
  size,
  className,
}: {
  size: "large" | "small";
  className?: string;
}) {
  const large = size === "large";

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center border-[3px] border-ridge text-center font-pixel text-ink-soft",
        large ? "text-2xs h-[78px] w-[78px] leading-normal" : "h-[38px] w-[38px]",
        large ? HATCH_LARGE : HATCH_SMALL,
        className,
      )}
      aria-hidden="true"
    />
  );
}
