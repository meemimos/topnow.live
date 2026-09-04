import { Lcd, Odometer } from "@/components/counters/odometer";
import { Plate } from "@/components/ui/plate";
import { ONLINE_WINDOW_MS } from "@/lib/visits/constants";
import type { Counts } from "@/lib/visits/store";

/**
 * The two counter panels (#15).
 *
 * ## The line under the LCD
 *
 * The prototype reads *"looking at slot 01 right now"*. The product cannot know
 * that. Nothing measures which part of the page anybody's eyes are on, and
 * building it would mean instrumenting scroll position per visitor — which is
 * both more tracking than a leaderboard has any business doing and more than the
 * sentence is worth.
 *
 * The issue's rule is that the line must be true or absent. It is neither
 * dropped nor faked: it says **"on the board right now"**, which is exactly what
 * the number beside it measures. The shape of the prototype's panel survives;
 * the claim it makes is one the server can actually stand behind.
 */

const PANEL = "flex flex-1 basis-[250px] flex-wrap items-center gap-x-3 gap-y-2 px-[11px] py-[9px]";

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000);
  return value === 1 ? "minute" : `${value} minutes`;
}

export function Counters({ counts }: { counts: Counts }) {
  const onlineWindow = minutes(ONLINE_WINDOW_MS);

  return (
    <section aria-label="Site counters" className="mt-3 flex flex-wrap gap-2">
      <Plate className={PANEL}>
        <span className="text-xs font-pixel">VISITS SINCE LAUNCH</span>
        <div className="ml-auto">
          <Odometer
            value={counts.visits}
            label={`${counts.visits.toLocaleString("en-US")} visits since launch`}
          />
        </div>
      </Plate>

      <Plate className={PANEL}>
        <span
          className="h-[9px] w-[9px] shrink-0 border border-meter-dim bg-meter [animation:tn-blink_1.3s_steps(1,end)_infinite]"
          aria-hidden="true"
        />
        <span className="text-xs font-pixel">ONLINE NOW</span>
        <Lcd
          value={counts.online}
          label={
            counts.online === 0
              ? "Nobody on the board right now"
              : `${counts.online} on the board right now`
          }
        />
        <span className="text-base basis-full">
          {/* True, unlike the prototype's per-slot claim: this is precisely what
              the number beside it counts. */}
          on the board right now
          <span className="text-ink-soft"> — seen in the last {onlineWindow}</span>
        </span>
      </Plate>
    </section>
  );
}
