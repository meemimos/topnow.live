import type { Metadata } from "next";

import { CheckoutFlow } from "@/components/checkout/flow";
import { ServerClockProvider } from "@/components/clock/provider";
import { Plate } from "@/components/ui/plate";
import { TitleBar } from "@/components/ui/title-bar";
import { serverNow } from "@/lib/time/server";

export const metadata: Metadata = { title: "Pay for time — TopNow" };

// Prices depend on live queue state, so this is never prerendered.
export const dynamic = "force-dynamic";

export default function CheckoutPage() {
  const now = serverNow();

  return (
    <ServerClockProvider serverNow={now}>
      <main className="mx-auto flex max-w-[1020px] flex-col px-2 pt-2.5 pb-10">
        <Plate className="p-[3px]">
          <TitleBar meta="STEP 1 OF 2">THE METER</TitleBar>
          <CheckoutFlow />
        </Plate>
      </main>
    </ServerClockProvider>
  );
}
