import { Plate } from "@/components/ui/plate";
import { NOTHING_YET, describe, type TickerEvent } from "@/lib/ticker/events";
import { formatClock } from "@/lib/time";

/**
 * The activity ticker (#16).
 *
 * Every item traces to a real `purchase` transition or a real hourly sample, and
 * carries the timestamp it actually happened at. Nothing here has a source that
 * can be written to, so there is nothing to seed and nothing to pad a quiet hour
 * with.
 *
 * ## A quiet ticker is allowed to be quiet
 *
 * If the board has taken no purchases, the strip says so in one sentence and
 * stops. If the last real thing happened yesterday, the strip shows that —
 * because it is what happened, and "nothing since yesterday" is information.
 * What it never does is invent motion.
 *
 * ## Motion
 *
 * The two copies below are the standard seamless marquee: the pair slides
 * exactly one copy's width, so the loop has no seam. The second copy is
 * `aria-hidden`, because it is the same events again and a screen reader should
 * hear them once.
 *
 * Under `prefers-reduced-motion` the animation is off and the second copy is
 * `display:none` — out of the layout and out of the accessibility tree — leaving
 * a plain row the reader can scroll themselves. That is deliberate: merely
 * pausing a marquee freezes it part-way through and hides whatever had not
 * scrolled into view yet, which is worse than never moving.
 *
 * ## Not a live region
 *
 * The strip is server rendered and changes only on a fresh render, so an
 * `aria-live` region here would be one that never fires — noise in the
 * accessibility tree in exchange for nothing. It is a labelled list, which is
 * what it is.
 */

function Item({ event }: { event: TickerEvent }) {
  const { before, handle, after } = describe(event);

  return (
    <li className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-2xs font-pixel text-ink-soft" data-numeric>
        {formatClock(event.at)}
      </span>
      <span className="text-base">
        {before}
        {/* Its own text node. A handle is user content, and keeping it a value
            rather than part of a sentence is what keeps it one. */}
        {handle && <span className="font-bold">{handle}</span>}
        {after}
      </span>
    </li>
  );
}

function Strip({ events, hidden }: { events: TickerEvent[]; hidden?: boolean }) {
  return (
    <ul
      // The trailing gap lives *inside* each copy (`pe-5`) rather than between
      // the two. `translateX(-50%)` is half the animated container, so a gap
      // sitting between the copies makes half the container one copy plus half
      // a gap — and the strip jumped ten pixels on every loop.
      className="m-0 flex shrink-0 list-none items-baseline gap-x-5 p-0 pe-5"
      aria-hidden={hidden ? "true" : undefined}
    >
      {events.map((event, index) => (
        <Item key={`${event.kind}-${event.at.getTime()}-${event.slot}-${index}`} event={event} />
      ))}
    </ul>
  );
}

export function Ticker({ events }: { events: TickerEvent[] }) {
  return (
    <section aria-label="Recent activity" className="mt-2">
      <Plate className="overflow-hidden px-[11px] py-[7px]">
        {events.length === 0 ? (
          <p className="text-base m-0" data-ticker-empty>
            {NOTHING_YET}
          </p>
        ) : (
          <div className="flex overflow-x-auto motion-safe:overflow-x-hidden" data-ticker>
            <div className="flex shrink-0 motion-safe:animate-[tn-ticker_38s_linear_infinite]">
              <Strip events={events} />
              {/* The seamless half. Displayed only when it will actually move —
                  a motionless duplicate would just be the same events twice. */}
              <div className="hidden motion-safe:flex">
                <Strip events={events} hidden />
              </div>
            </div>
          </div>
        )}
      </Plate>
    </section>
  );
}
