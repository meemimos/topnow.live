"use client";

import { Slot } from "radix-ui";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/utils";

/**
 * BevelButton — silver by default, navy for primary, inverting on :active.
 *
 * The press is the bevel flipping, exactly as in TopNow.html. It is a real
 * `<button>` so keyboard handling, disabled semantics and the focus ring come
 * for free rather than being reimplemented.
 */
const BUTTON_VARIANTS = {
  silver: cn(
    "bg-plate text-ink",
    "shadow-control active:shadow-control-pressed",
    "hover:bg-plate-light/40",
  ),
  navy: cn(
    "bg-navy text-paper",
    "shadow-control-navy active:shadow-control-navy-pressed",
    "hover:bg-navy-light/20",
  ),
} as const;

const BUTTON_SIZES = {
  /** Table filters, range switches, inline controls. */
  sm: "px-[7px] py-[3px] text-base",
  /** The default control. */
  md: "px-[11px] py-[10px] text-sm",
  /** The primary action on a panel — "TAKE SLOT 01 — $25.50". */
  lg: "w-full px-4 py-[14px] text-md",
} as const;

export type BevelButtonVariant = keyof typeof BUTTON_VARIANTS;
export type BevelButtonSize = keyof typeof BUTTON_SIZES;

type BevelButtonProps = {
  variant?: BevelButtonVariant;
  size?: BevelButtonSize;
  /** Renders the child element instead of a button — for links that look like buttons. */
  asChild?: boolean;
  /**
   * Marks a toggle as on, which swaps it to navy and presses the bevel in.
   * Sets aria-pressed, so assistive tech gets the state the bevel is showing.
   */
  selected?: boolean;
} & ComponentPropsWithoutRef<"button">;

export function BevelButton({
  variant = "silver",
  size = "md",
  asChild = false,
  selected,
  className,
  type,
  ...rest
}: BevelButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  const effectiveVariant = selected ? "navy" : variant;

  return (
    <Component
      // A button inside a form defaults to type="submit", which submits it by
      // accident. Every control here is a button unless it says otherwise.
      type={asChild ? undefined : (type ?? "button")}
      aria-pressed={selected === undefined ? undefined : selected}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-2 text-center",
        // `asChild` renders a link, and a link is underlined by the base rules.
        // A button is not.
        "no-underline",
        "border border-ink font-pixel font-bold tracking-[0.04em]",
        "disabled:cursor-not-allowed disabled:text-ink-faint",
        BUTTON_VARIANTS[effectiveVariant],
        BUTTON_SIZES[size],
        // After the variant, so twMerge keeps this shadow rather than dropping
        // it: a toggle that is on holds the inverted bevel even when it is not
        // being clicked, which is how the prototype shows the active filter.
        selected && "shadow-control-navy-pressed",
        className,
      )}
      {...rest}
    />
  );
}
