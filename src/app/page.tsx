import { headers } from "next/headers";

import { Board } from "@/components/board/board";
import { Counters } from "@/components/counters/counters";
import { ServerClockProvider } from "@/components/clock/provider";
import { LedgerTable } from "@/components/ledger/ledger";
import { MarketPanel } from "@/components/market/market";
import { PricingDialog } from "@/components/pricing/pricing-dialog";
import { Ticker } from "@/components/ticker/ticker";
import { BevelButton } from "@/components/ui/bevel-button";
import { readAvatars } from "@/lib/avatar/store";
import { readEmbed } from "@/lib/embed/store";
import { clientConfig } from "@/lib/config/client";
import { readMarket } from "@/lib/market/read";
import { DURATION_HOURS, askHrCents, baseHrCents } from "@/lib/pricing";
import { currentAsks } from "@/lib/purchase/queue";
import { currentBoard, readLedger } from "@/lib/purchase/state";
import { readTicker } from "@/lib/ticker/read";
import { serverNow } from "@/lib/time/server";
import { readCounts, recordVisit } from "@/lib/visits/store";

// The board changes every second and reflects live state, so it is never
// prerendered. Reading it also promotes anything whose window has closed (#1).
export const dynamic = "force-dynamic";

export default async function Home() {
  const now = serverNow();
  // The board read promotes; the ledger read must see the result of that, so it
  // runs after rather than alongside. Both are given the same `now`, so the two
  // surfaces cannot disagree about who is on the board.
  const slots = await currentBoard(new Date(now));
  const ledger = await readLedger(new Date(now));

  // Decision D3: the market panel is absent until a slot has real trading
  // behind it. The flag is what reveals it — and #13's sparse state is what it
  // reveals into, not a placeholder for it.
  const showMarket = clientConfig.NEXT_PUBLIC_MARKET_PANEL_ENABLED;
  const market = showMarket ? await readMarket(new Date(now)) : null;

  // The pricing dialog quotes the same ask checkout would charge, read per
  // request — a static price list beside a surging board is worse than none.
  const asks = await currentAsks(DURATION_HOURS, new Date(now));

  // TopNow's own avatar copies (#19). A read, never a resolution: the board must
  // not make a third-party request, and a page render must not be able to spend
  // an upstream rate-limit budget.
  const avatars = await readAvatars(slots.flatMap((slot) => (slot.live ? [slot.live] : [])));

  // Slot 01's post embed (#20). A read, like the avatars. Null covers every
  // reason there might be nothing to show — no post link, a platform with no
  // provider, a deleted post, a resolution that failed — and slot 01 renders the
  // profile card in all of them.
  const embed = await readEmbed(slots[0]?.live ?? null);

  // Note the visit, then read the counters (#15). Recording is idempotent within
  // the window, so a reload is not a second visit; reading comes from a cache,
  // so a page render never triggers a counting query however busy the board is.
  await recordVisit(await headers(), new Date(now));
  const counts = await readCounts(new Date(now));

  // What has actually happened (#16). Derived from purchase transitions and
  // hourly samples — there is no events table, so a quiet board simply produces
  // a quiet strip rather than one somebody could have filled.
  const activity = await readTicker(new Date(now));

  return (
    <ServerClockProvider serverNow={now}>
      <main className="mx-auto flex max-w-[1020px] flex-col px-2 pt-2.5 pb-10">
        <header>
          <h1 className="text-[clamp(24px,6.2vw,44px)] leading-[1.08] font-bold tracking-[-0.01em] text-balance text-paper [text-shadow:2px_2px_0_var(--color-ground-shade)]">
            Rent the top spot.
            <br />
            When the meter runs out, it&rsquo;s gone.
          </h1>
          <p className="text-lg mt-3 mb-0 max-w-[62ch] leading-[1.6] text-paper">
            Three slots, rented by the hour. Nobody outbids you and nobody keeps it. When the clock
            hits zero the slot reopens at base price.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <BevelButton variant="navy" asChild>
              <a href="/checkout">PAY FOR TIME</a>
            </BevelButton>
            <PricingDialog
              rows={asks.map((ask) => ({
                slot: ask.slot,
                baseHrCents: baseHrCents(ask.slot),
                multiplierCm: ask.multiplierCm,
                askHrCents: askHrCents(ask.slot, ask.multiplierCm),
              }))}
              // The legend explains the chart, so it hides with it (D3).
              showChartLegend={showMarket}
              trigger={<BevelButton>SEE PRICING</BevelButton>}
            />
          </div>
        </header>

        <Board slots={slots} now={now} avatars={avatars} embed={embed} />
        <Ticker events={activity} />
        <Counters counts={counts} />
        <LedgerTable ledger={ledger} />
        {/* Below both the board and the ledger, deliberately (#12): the chart
            corroborates the board, it does not sell the slot. */}
        {market && <MarketPanel market={market} now={now} />}
      </main>
    </ServerClockProvider>
  );
}
