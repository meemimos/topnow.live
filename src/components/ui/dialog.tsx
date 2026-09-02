"use client";

import { Dialog as RadixDialog } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { Plate } from "@/components/ui/plate";
import { cn } from "@/lib/utils";

/**
 * Dialog — the retheme'd modal.
 *
 * Built on Radix rather than a hand-rolled overlay, because the accessible parts
 * of a modal are the parts easiest to get subtly wrong: the focus trap, restoring
 * focus to whatever opened it, Escape, `aria-modal`, and inert-ing the page
 * behind. Radix does all of that; this file only dresses it.
 *
 * The chrome is the prototype's: a floating plate with a navy title bar and an
 * `X` that is a real button rather than a glyph with a click handler.
 */

export function Dialog({ children, ...rest }: ComponentPropsWithoutRef<typeof RadixDialog.Root>) {
  return <RadixDialog.Root {...rest}>{children}</RadixDialog.Root>;
}

export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
}: {
  /** Required: a modal without an accessible name is a modal nobody can place. */
  title: string;
  /** Announced with the title. Rendered visually hidden. */
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <RadixDialog.Portal>
      {/* The desktop, dimmed. Scrolling lives on the overlay so a tall dialog
          scrolls the whole modal rather than trapping a scrollbar inside a
          panel — which at 360px is the difference between readable and not. */}
      <RadixDialog.Overlay className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-[rgb(0_40_40/0.72)] px-2.5 py-4">
        <RadixDialog.Content
          className={cn("w-full max-w-[560px] focus:outline-none", className)}
          aria-describedby={description ? undefined : undefined}
        >
          <Plate variant="float" className="p-[3px]">
            <div className="flex items-center justify-between gap-2 bg-navy px-2 py-1.5 text-paper">
              <RadixDialog.Title className="text-md font-pixel font-bold tracking-[0.04em]">
                {title}
              </RadixDialog.Title>
              <RadixDialog.Close
                aria-label="Close"
                className="text-base cursor-pointer border border-ink bg-plate px-[7px] py-[3px] font-pixel text-ink shadow-plate active:shadow-plate-inset"
              >
                X
              </RadixDialog.Close>
            </div>

            {description && (
              <RadixDialog.Description className="sr-only">{description}</RadixDialog.Description>
            )}

            <div className="mt-[3px] bg-paper px-3 pt-3.5 pb-4">{children}</div>
          </Plate>
        </RadixDialog.Content>
      </RadixDialog.Overlay>
    </RadixDialog.Portal>
  );
}
