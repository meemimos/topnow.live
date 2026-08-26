import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * TitleBar — the navy header strip, with a right-aligned meta slot.
 *
 * Two tones, both from TopNow.html: `navy` for panel headers, `well` for the
 * lighter section strips that sit inside a plate.
 */
const TITLE_BAR_TONES = {
  navy: "bg-navy text-paper",
  well: "bg-well text-ink border-b border-rule",
} as const;

const META_TONES = {
  navy: "text-navy-ink",
  well: "text-ink-soft",
} as const;

export type TitleBarTone = keyof typeof TITLE_BAR_TONES;

type TitleBarProps = {
  /** The label on the left. Rendered in Silkscreen, as every label is. */
  children: ReactNode;
  /** Right-aligned meta — a timestamp, a count, a status. */
  meta?: ReactNode;
  tone?: TitleBarTone;
} & Omit<ComponentPropsWithoutRef<"div">, "children">;

export function TitleBar({ children, meta, tone = "navy", className, ...rest }: TitleBarProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-[7px] py-[5px]",
        "font-pixel text-sm",
        TITLE_BAR_TONES[tone],
        className,
      )}
      {...rest}
    >
      <span className="font-bold tracking-[0.04em]">{children}</span>
      {meta !== undefined && (
        <span className={cn("text-2xs", META_TONES[tone])} data-numeric>
          {meta}
        </span>
      )}
    </div>
  );
}
