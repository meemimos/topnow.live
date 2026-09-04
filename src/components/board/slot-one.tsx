import type { Purchase } from "@prisma/client";

import { EmbeddedPost } from "@/components/board/embedded-post";
import { Meter } from "@/components/board/meter";
import { Avatar } from "@/components/board/avatar";
import { PLATFORMS, displayNameFor, linkTextFor } from "@/components/board/platform";
import { BevelButton } from "@/components/ui/bevel-button";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import type { BoardAvatar } from "@/lib/avatar/store";
import { clickThroughHref } from "@/lib/embed/clicks";
import type { BoardEmbed } from "@/lib/embed/store";
import { formatMoney } from "@/lib/pricing/format";
import { formatClock } from "@/lib/time";

/**
 * Slot 01 (#6).
 *
 * A different component from slots 02 and 03, not a bigger one. If the top slot
 * were the same card at a larger size, the price tiers would have no visible
 * justification and nobody would pay two and a half times the rate for it.
 *
 * What the premium buys, structurally: a 78px avatar, the handle at display
 * size, room for the tagline to breathe, and the meter given a full column of
 * its own rather than a compact readout.
 *
 * The embedded post panel (#20) sits under the profile card when there is a post
 * to show. When there is not — no post link, a platform with no provider, a
 * deleted post, a resolution that failed — `embed` is null and the panel is
 * simply absent. Slot 01 is then the profile card, which is a complete state
 * rather than a hole. Never a dead card at number one, and never an explanation
 * of why a third party did not answer.
 */
export function SlotOne({
  live,
  avatar,
  embed,
  queuedCount,
  cta,
}: {
  live: Purchase;
  /** Undefined when nothing resolved — the placeholder renders instead (#19). */
  avatar: BoardAvatar | undefined;
  /** Null whenever there is nothing renderable. The panel is then absent (#20). */
  embed: BoardEmbed | null;
  queuedCount: number;
  cta: { label: string; disabled?: boolean };
}) {
  const platform = PLATFORMS[live.platform];

  return (
    <Plate className="mt-1.5 p-[3px]">
      <TitleBar meta={live.endsAt ? `PAID THROUGH ${formatClock(live.endsAt)}` : undefined}>
        SLOT 01
      </TitleBar>

      <div className="flex flex-wrap gap-3 px-2.5 py-3">
        {/* Fills its column so the card and the meter align. The embedded post
            panel (#20) will occupy the extra height when it lands. */}
        <div className="flex min-w-[250px] flex-[1_1_300px] flex-col">
          <Plate variant="inset" surface="paper" className="h-full p-3">
            <div className="flex items-start gap-3">
              <Avatar avatar={avatar} size="large" />

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-[7px]">
                  <span className="text-[clamp(17px,4.6vw,22px)] font-bold break-all">
                    {displayNameFor(live)}
                  </span>
                  <span className="bg-ink px-[5px] py-[3px] font-pixel text-xs text-paper">
                    {platform.tag}
                  </span>
                </div>

                <p className="text-lg mt-[7px] mb-[9px] leading-[1.55]">{live.tagline}</p>

                {/* Routed through our own counter (#20) so the clicks figure is
                    something TopNow measured rather than borrowed. The text is
                    still the real destination — the link says where it goes. */}
                <a
                  className="text-md break-all"
                  href={clickThroughHref(live.id)}
                  rel="nofollow ugc noopener noreferrer"
                  target="_blank"
                >
                  {linkTextFor(live.targetUrl)}
                </a>
              </div>
            </div>

            {embed && <EmbeddedPost embed={embed} clicks={live.clicks} />}
          </Plate>
        </div>

        <div className="flex min-w-[262px] flex-[1_1_300px] flex-col gap-2.5">
          <Meter endsAt={live.endsAt} durationH={live.durationH} />

          <Plate
            surface="note"
            className="text-[11.5px] border-2 px-[11px] py-[9px] leading-[1.7] shadow-none"
          >
            <div className="flex justify-between gap-2">
              <span>paid</span>
              <span data-numeric>{formatMoney(live.totalPaidCents)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span>in the queue</span>
              <span data-numeric>
                {queuedCount === 0 ? "nobody waiting" : `${queuedCount} waiting`}
              </span>
            </div>
          </Plate>

          <BevelButton size="lg" disabled={cta.disabled}>
            {cta.label}
          </BevelButton>
        </div>
      </div>
    </Plate>
  );
}
