import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Plate — the bevelled panel everything else sits on.
 *
 * Three variants, all measured from TopNow.html:
 *
 *   raised  silver chrome, 2px bevel. The default panel.
 *   inset   the bevel inverted. Wells, strips, table headers.
 *   float   raised plus a hard drop shadow. Modals and anything above the desktop.
 */
const PLATE_VARIANTS = {
  raised: "bg-plate shadow-plate",
  inset: "bg-well shadow-plate-inset",
  float: "bg-plate shadow-float",
} as const;

const PLATE_SURFACES = {
  plate: "bg-plate",
  paper: "bg-paper",
  well: "bg-well",
  note: "bg-note",
} as const;

export type PlateVariant = keyof typeof PLATE_VARIANTS;
export type PlateSurface = keyof typeof PLATE_SURFACES;

type PlateProps<T extends ElementType> = {
  as?: T;
  variant?: PlateVariant;
  /** Overrides the variant's own background without changing its bevel. */
  surface?: PlateSurface;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "children">;

export function Plate<T extends ElementType = "div">({
  as,
  variant = "raised",
  surface,
  className,
  children,
  ...rest
}: PlateProps<T>) {
  const Component = (as ?? "div") as ElementType;

  return (
    <Component
      className={cn(
        "border border-ink",
        PLATE_VARIANTS[variant],
        surface && PLATE_SURFACES[surface],
        className,
      )}
      {...rest}
    >
      {children}
    </Component>
  );
}

/**
 * The empty-slot treatment: a dashed border rather than a bevel.
 *
 * This is a designed state, not a fallback — an open slot at base price is a
 * perfectly good thing for the board to be showing (#6).
 */
export function VacantPlate({ className, children, ...rest }: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn("border-[3px] border-dashed border-ink bg-vacant", className)} {...rest}>
      {children}
    </div>
  );
}
