import { Board } from "@/components/board/board";
import { ServerClockProvider } from "@/components/clock/provider";
import { LedgerTable } from "@/components/ledger/ledger";
import { MarketPanel } from "@/components/market/market";
import { BevelButton } from "@/components/ui/bevel-button";
import { clientConfig } from "@/lib/config/client";
import { readMarket } from "@/lib/market/read";
import { currentBoard, readLedger } from "@/lib/purchase/state";
import { serverNow } from "@/lib/time/server";

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
            <BevelButton variant="navy">PAY FOR TIME</BevelButton>
            <BevelButton>SEE PRICING</BevelButton>
          </div>
        </header>

        <Board slots={slots} now={now} />
        <LedgerTable ledger={ledger} />
        {/* Below both the board and the ledger, deliberately (#12): the chart
            corroborates the board, it does not sell the slot. */}
        {market && <MarketPanel market={market} now={now} />}
      </main>
    </ServerClockProvider>
  );
}
