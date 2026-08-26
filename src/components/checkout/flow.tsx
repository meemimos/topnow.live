"use client";

import { useState } from "react";

import type { CheckoutQuote } from "@/app/actions/checkout";
import { CheckoutForm } from "@/components/checkout/form";

/**
 * Holds the quote the form produces.
 *
 * The receipt (#9) and the queue position (#10) render from it, so it lives one
 * level above the form rather than inside it.
 */
export function CheckoutFlow() {
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);

  return (
    <div className="flex flex-wrap gap-3 bg-plate p-2">
      <div className="min-w-[280px] flex-[1_1_340px]">
        <CheckoutForm onQuote={setQuote} />
      </div>
      <div className="min-w-[260px] flex-[1_1_300px]">
        {quote ? (
          // Placeholder until #9's receipt panel lands. Shows the real figures
          // the server priced, so nothing here is invented.
          <div className="bg-paper p-3">
            <div className="text-sm font-pixel font-bold">QUOTED</div>
            <pre className="text-md mt-2 overflow-x-auto">{JSON.stringify(quote, null, 2)}</pre>
          </div>
        ) : (
          <div className="text-md bg-paper p-3 text-ink-soft">
            Fill in the listing and the receipt appears here.
          </div>
        )}
      </div>
    </div>
  );
}
