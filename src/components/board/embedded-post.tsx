"use client";

import { useState } from "react";

import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import type { BoardEmbed } from "@/lib/embed/store";
import { cn } from "@/lib/utils";

/**
 * The embedded post panel on slot 01 (#20).
 *
 * ## It never renders if there is nothing to render
 *
 * The caller passes `null` for a listing with no post, a platform with no
 * provider, a deleted post, or a resolution that failed — and this component is
 * simply not on the page. That is the issue's central rule: **degrade silently
 * to the profile card, never a dead card at number one.** No error text, no
 * empty frame, no "could not load", and no layout jump, because the profile card
 * is a complete state that was already the whole of slot 01 before this landed.
 *
 * ## The frame does not load until someone asks for it
 *
 * First paint shows our own stored thumbnail and the post's real title. The
 * provider's iframe is mounted on click.
 *
 * Two reasons, and they point the same way. A visitor who came to look at a
 * leaderboard has not asked to be introduced to YouTube, and #19 removed exactly
 * that kind of unrequested third-party request from this page. And an iframe
 * that loads on every board render makes the page's weight and latency a
 * function of a third party's, on the surface that has to stay fast.
 *
 * When it does mount, it mounts sandboxed. The `sandbox` list below is written
 * here rather than taken from the provider's markup — which is discarded during
 * resolution precisely so a provider cannot choose its own permissions.
 */

/**
 * Deliberately without `allow-same-origin`.
 *
 * With it, the frame gets its own origin back and can reach into storage and
 * cookies for that origin; without it the frame is opaque and cannot touch this
 * page. `allow-scripts` is unavoidable — a video player is a script — and the
 * pair `allow-scripts allow-same-origin` is the combination that lets a frame
 * remove its own sandbox, so the two are never used together here.
 */
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-presentation";

function thumbnailSrc(embed: BoardEmbed): string {
  return `/api/embed/${embed.id}/thumbnail?v=${embed.thumbnailVersion}`;
}

/** A count, or nothing at all. Never a zero standing in for "we do not know". */
function Count({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  return (
    <span className="flex items-center gap-[7px]">
      <span className="text-[13px]" data-numeric>
        {value.toLocaleString("en-US")} {label}
      </span>
    </span>
  );
}

export function EmbeddedPost({ embed, clicks }: { embed: BoardEmbed; clicks: number }) {
  const [playing, setPlaying] = useState(false);

  const ratio =
    embed.iframeWidth && embed.iframeHeight ? embed.iframeHeight / embed.iframeWidth : 9 / 16;

  return (
    <Plate variant="inset" surface="paper" className="mt-2.5 p-0">
      <TitleBar>EMBEDDED POST</TitleBar>

      {embed.title && (
        <p className="text-[13.5px] mt-0 mb-0 px-2.5 pt-2.5 leading-[1.5]">
          {embed.title}
          {embed.authorName && <span className="text-ink-soft"> — {embed.authorName}</span>}
        </p>
      )}

      {/* The box is sized from the provider's own aspect ratio before anything
          loads, so swapping the thumbnail for the frame cannot move the page. */}
      <div
        className="relative mx-2.5 mt-2.5 overflow-hidden border border-ink bg-ink"
        style={{ aspectRatio: `1 / ${ratio}` }}
      >
        {playing ? (
          <iframe
            src={embed.iframeSrc}
            title={embed.title ?? "Embedded post"}
            sandbox={SANDBOX}
            // No camera, microphone or geolocation. A post embed needs none of
            // them, and a permissions policy is only as good as its narrowest
            // entry.
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="no-referrer"
            loading="lazy"
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className={cn(
              "group absolute inset-0 flex h-full w-full cursor-pointer items-center justify-center border-0 p-0",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-paper",
            )}
          >
            {embed.hasThumbnail && (
              /* Our own re-encoded copy, same-origin. Never the provider's CDN —
                 that would put back the third-party request #19 removed. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbnailSrc(embed)}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                decoding="async"
                loading="lazy"
              />
            )}
            <span className="text-md relative border border-ink bg-plate px-3 py-2 font-pixel text-ink shadow-plate group-active:shadow-plate-inset">
              ▶ PLAY POST
            </span>
            {/* Said once, plainly, rather than in a cookie-style banner. */}
            <span className="text-2xs absolute right-0 bottom-0 left-0 bg-[rgb(0_0_0/0.66)] px-2 py-1 text-center font-pixel text-paper">
              LOADS FROM THE PLATFORM WHEN YOU PRESS PLAY
            </span>
          </button>
        )}
      </div>

      <div className="text-md flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2">
        {/* Views only when the provider actually reported them — in practice none
            of the three do, so this row is usually absent. A number TopNow
            cannot measure is not printed. */}
        <Count label="views" value={embed.providerViews} />
        <Count label="clicks" value={clicks} />
      </div>
    </Plate>
  );
}
