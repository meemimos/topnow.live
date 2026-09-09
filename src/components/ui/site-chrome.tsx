import Link from "next/link";

import { PLATFORMS } from "@/components/board/platform";
import { ServerTime } from "@/components/clock/server-time";
import { Plate } from "@/components/ui/plate";
import { SLOTS } from "@/lib/pricing";

/**
 * The window chrome (#5).
 *
 * The prototype frames the whole product as an application window: a navy title
 * bar, a status strip under it, and a status bar along the bottom. The build
 * went straight to the panels and left the frame out, which the fidelity pass
 * made obvious the moment the two full pages were put side by side — the app
 * read as three panels floating on a teal ground rather than as a window.
 *
 * Every value in it is real. The open-slot count comes from the board, the
 * server time from the same clock every countdown reads (#3), and the platform
 * list from the table the board and checkout use — so none of it can drift into
 * saying something that is not so.
 */

export function SiteHeader({ open }: { open?: number }) {
  return (
    <header className="mb-2.5">
      <div className="flex items-center justify-between gap-2 border border-ink bg-navy px-2 py-1 font-pixel text-paper">
        <span className="text-md font-bold tracking-[0.06em]">TOPNOW</span>
        <span className="text-2xs text-navy-ink">TOPNOW.LIVE</span>
      </div>

      <Plate className="mt-[3px] flex flex-wrap items-center justify-between gap-2 px-2 py-1">
        <span className="text-2xs font-pixel">
          {SLOTS.length} slots
          {/* Only when it is known: this strip renders on pages that have not
              read the board, and inventing a count there would be inventing a
              count. */}
          {open !== undefined && ` · ${open} open`} · billed by the hour
        </span>
        <span className="text-2xs flex items-center gap-1.5 font-pixel">
          {/* Amber, not the prototype's green. Green and red mean price
              direction on the chart and appear nowhere else — a green "up" dot
              in the chrome is exactly the leak that rule exists to prevent. */}
          <span
            className="h-[9px] w-[9px] shrink-0 border border-meter-dim bg-meter"
            aria-hidden="true"
          />
          server is up
        </span>
      </Plate>
    </header>
  );
}

/**
 * The bottom status bar.
 *
 * `serverNow` is optional because the clock is a context every countdown shares,
 * and pages outside that provider (the rules, admin) have no clock to read. They
 * get the bar without the time rather than a second, unsynchronised one.
 */
export function SiteFooter({ serverNow }: { serverNow?: number }) {
  return (
    <footer className="mt-3">
      <Plate className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-2 py-1.5">
        <span className="text-2xs font-pixel">TOPNOW — METERED ATTENTION</span>

        <span className="text-2xs font-pixel text-ink-soft">
          {Object.values(PLATFORMS)
            .map((platform) => platform.label.toUpperCase())
            .join(" · ")}
        </span>

        <span className="text-2xs flex flex-wrap items-center gap-x-3 gap-y-1 font-pixel">
          <Link href="/terms">The rules</Link>
          {serverNow !== undefined && <ServerTime serverNow={serverNow} />}
        </span>
      </Plate>
    </footer>
  );
}

/**
 * How the product works, in three sentences.
 *
 * Straight from the prototype, and it earns its place: the whole model is
 * unusual enough that somebody arriving cold needs the three states named. It
 * sits at the bottom because by then they have seen the board doing it.
 */
const STEPS = [
  {
    label: "01 — PAY",
    body: "Pick a slot, pick a duration, pay once. Price is rate × hours × surge. Nothing else.",
  },
  {
    label: "02 — RUN",
    body: "Your listing goes live with a countdown anyone can watch. One link, one line of copy.",
  },
  {
    label: "03 — EXPIRE",
    body: "At zero the slot reopens at base price. No cumulative bidding, no permanent kings.",
  },
] as const;

export function HowItWorks() {
  return (
    <section aria-label="How it works" className="mt-3 flex flex-wrap gap-2">
      {STEPS.map((step) => (
        <Plate key={step.label} surface="paper" className="min-w-[220px] flex-1 px-3 py-2.5">
          <div className="text-2xs font-pixel font-bold">{step.label}</div>
          <p className="text-md mt-1.5 mb-0 leading-[1.6]">{step.body}</p>
        </Plate>
      ))}
    </section>
  );
}
