import type { Purchase } from "@prisma/client";

import { Avatar } from "@/components/board/avatar";
import { CompactMeter } from "@/components/board/meter";
import { PLATFORMS, displayNameFor, linkTextFor } from "@/components/board/platform";
import { BevelButton } from "@/components/ui/bevel-button";
import { Plate, VacantPlate } from "@/components/ui/plate";
import type { BoardAvatar } from "@/lib/avatar/store";
import { clickThroughHref } from "@/lib/embed/clicks";

/**
 * Slots 02 and 03 (#6): a compact row, structurally distinct from slot 01.
 *
 * Everything the top slot gives its own column — avatar, meter, tagline — is
 * inline here at a smaller scale, which is what makes the price difference
 * legible without anyone having to read the pricing dialog.
 */
export function SlotRow({
  slot,
  live,
  avatar,
  cta,
}: {
  slot: number;
  live: Purchase;
  /** Undefined when nothing resolved — the placeholder renders instead (#19). */
  avatar: BoardAvatar | undefined;
  cta: { label: string; disabled?: boolean };
}) {
  const platform = PLATFORMS[live.platform];

  return (
    <Plate className="flex flex-wrap items-center gap-2.5 px-[11px] py-[9px]">
      <span className="text-md shrink-0 font-pixel">{String(slot).padStart(2, "0")}</span>

      <Avatar avatar={avatar} size="small" />

      <div className="min-w-[165px] flex-[1_1_190px]">
        <div className="flex items-center gap-1.5">
          <span className="text-[14.5px] font-bold break-all">{displayNameFor(live)}</span>
          <span className="text-2xs bg-ink px-1 py-0.5 font-pixel text-paper">{platform.tag}</span>
        </div>
        <div className="text-md mt-0.5 leading-[1.5]">{live.tagline}</div>
      </div>

      {/* Counted, like slot 01's (#20). */}
      <a
        className="text-[11.5px] shrink-0 break-all"
        href={clickThroughHref(live.id)}
        rel="nofollow ugc noopener noreferrer"
        target="_blank"
      >
        {linkTextFor(live.targetUrl)}
      </a>

      <CompactMeter endsAt={live.endsAt} />

      <BevelButton size="sm" disabled={cta.disabled} className="shrink-0">
        {cta.label}
      </BevelButton>
    </Plate>
  );
}

/**
 * An open slot.
 *
 * A designed state rather than a fallback. On launch day this is what the whole
 * board looks like, and "available at base" is a perfectly good thing for it to
 * be saying — so it says that, plainly, rather than apologising for being empty.
 */
export function VacantSlotRow({
  slot,
  cta,
  note,
}: {
  slot: number;
  cta: { label: string; disabled?: boolean };
  note: string;
}) {
  return (
    <VacantPlate className="flex flex-wrap items-center gap-2.5 px-[11px] py-[9px]">
      <span className="text-md shrink-0 font-pixel">{String(slot).padStart(2, "0")}</span>

      <div
        className="text-2xl flex h-[38px] w-[38px] shrink-0 items-center justify-center border-2 border-dashed border-ink-soft font-pixel text-ink-soft"
        aria-hidden="true"
      >
        +
      </div>

      <div className="min-w-[165px] flex-[1_1_190px]">
        <div className="text-[14.5px] font-bold">Open now</div>
        <div className="text-md mt-0.5 leading-[1.5]">{note}</div>
      </div>

      <BevelButton variant="navy" size="sm" disabled={cta.disabled} className="ml-auto shrink-0">
        {cta.label}
      </BevelButton>
    </VacantPlate>
  );
}
