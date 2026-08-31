import { SlotOne } from "@/components/board/slot-one";
import { SlotRow, VacantSlotRow } from "@/components/board/slot-row";
import { Plate, VacantPlate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import { BevelButton } from "@/components/ui/bevel-button";
import { DURATION_HOURS, quoteForQueue, type Slot } from "@/lib/pricing";
import { formatMoney, slotLabel } from "@/lib/pricing/format";
import { acceptsNewBookings } from "@/lib/purchase/queue";
import type { BoardSlot } from "@/lib/purchase/state";

/**
 * The board (#6): `status = live`, three slots.
 *
 * Every field comes from a real purchase. An empty board is an empty board —
 * three slots available at base, which is a perfectly good page and exactly
 * what launch day looks like. Nothing is invented to fill it.
 */

/** The shortest duration, used to quote a headline rate rather than a total. */
const HEADLINE_HOURS = DURATION_HOURS[0];

function ctaFor(state: BoardSlot, waitHours: number) {
  const open = acceptsNewBookings(waitHours);
  if (!open) {
    return { label: `${slotLabel(state.slot)} FULL — TRY ANOTHER`, disabled: true };
  }

  const quote = quoteForQueue(state.slot as Slot, HEADLINE_HOURS, state.queuedHours);

  // The button says what actually happens. Queueing behind someone is a
  // different proposition from taking a free slot, and the label admits it.
  if (state.live) {
    const ahead = state.queuedCount;
    return {
      label:
        ahead === 0
          ? `JOIN QUEUE FOR ${String(state.slot).padStart(2, "0")} — NEXT UP`
          : `JOIN QUEUE FOR ${String(state.slot).padStart(2, "0")} — ${ahead} AHEAD`,
    };
  }

  return { label: `TAKE ${slotLabel(state.slot)} — ${formatMoney(quote.askHrCents)}/HR` };
}

/** Copy for an open slot, which depends on whether anyone is already waiting. */
function vacantNote(state: BoardSlot): string {
  if (state.queuedCount > 0) {
    return `${state.queuedCount} waiting — the next goes live the moment it is promoted.`;
  }
  const quote = quoteForQueue(state.slot as Slot, HEADLINE_HOURS, 0);
  return `Nobody waiting. Base price, no surge — ${formatMoney(quote.askHrCents)}/hr.`;
}

/** Slot 01 with nobody on it. The prototype never showed this; launch day is it. */
function VacantSlotOne({ state }: { state: BoardSlot }) {
  const cta = ctaFor(state, state.queuedHours);

  return (
    <Plate className="mt-1.5 p-[3px]">
      <TitleBar meta="OPEN NOW">SLOT 01</TitleBar>
      <VacantPlate className="m-[3px] flex flex-wrap items-center gap-3 px-3 py-6">
        <div
          className="text-3xl flex h-[78px] w-[78px] shrink-0 items-center justify-center border-2 border-dashed border-ink-soft font-pixel text-ink-soft"
          aria-hidden="true"
        >
          +
        </div>
        <div className="min-w-[200px] flex-1">
          <div className="text-[clamp(17px,4.6vw,22px)] font-bold">The top spot is open</div>
          <p className="text-lg mt-1.5 mb-0 leading-[1.55]">{vacantNote(state)}</p>
        </div>
        <BevelButton variant="navy" disabled={cta.disabled} className="shrink-0">
          {cta.label}
        </BevelButton>
      </VacantPlate>
    </Plate>
  );
}

export function Board({ slots, now }: { slots: BoardSlot[]; now: number }) {
  const [one, two, three] = slots;

  return (
    <section aria-label="The board">
      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-1.5 px-0.5">
        <span className="text-lg font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          THE BOARD
        </span>
        <span className="text-sm font-pixel text-paper [text-shadow:1px_1px_0_var(--color-ground-shade)]">
          UPDATES EVERY SECOND
        </span>
      </div>

      {one.live ? (
        <SlotOne
          live={one.live}
          queuedCount={one.queuedCount}
          cta={ctaFor(one, one.queuedHours + remainingHoursOf(one, now))}
        />
      ) : (
        <VacantSlotOne state={one} />
      )}

      <div className="mt-2 flex flex-col gap-2">
        {[two, three].map((state) =>
          state.live ? (
            <SlotRow
              key={state.slot}
              slot={state.slot}
              live={state.live}
              cta={ctaFor(state, state.queuedHours + remainingHoursOf(state, now))}
            />
          ) : (
            <VacantSlotRow
              key={state.slot}
              slot={state.slot}
              cta={ctaFor(state, state.queuedHours)}
              note={vacantNote(state)}
            />
          ),
        )}
      </div>
    </section>
  );
}

/**
 * Hours left on the rental currently on the board.
 *
 * The wait cap counts this as well as the queue (#24), so the CTA has to know
 * about it — a slot can be closed to new bookings because of a long rental in
 * progress, not only because of a deep queue.
 *
 * `now` is passed in rather than read here, as everywhere else in this codebase:
 * the server's clock is read once per request (serverNow) and threaded down, so
 * a render cannot disagree with itself.
 */
function remainingHoursOf(state: BoardSlot, now: number): number {
  if (!state.live?.endsAt) return 0;
  return Math.max(0, (state.live.endsAt.getTime() - now) / 3_600_000);
}
