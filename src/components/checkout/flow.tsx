"use client";

import { useState, useTransition } from "react";

import { startPayment } from "@/app/actions/checkout";
import { CheckoutForm, type PricedListing } from "@/components/checkout/form";
import { Receipt } from "@/components/checkout/receipt";
import { Plate } from "@/components/ui/plate";

/**
 * Holds the quote the form produces, and takes the buyer to payment (#26).
 *
 * The receipt (#9) and the queue position (#10) render from the quote, so it
 * lives one level above the form rather than inside it.
 *
 * Taking the slot re-sends the listing rather than the price. The server prices
 * it again and locks that figure into the Stripe session, so a total edited in
 * the browser buys nothing. Nothing is written here either: the purchase row is
 * created by the webhook, once payment has actually cleared.
 */
export function CheckoutFlow() {
  const [priced, setPriced] = useState<PricedListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function take() {
    if (!priced) return;
    setError(null);
    startTransition(async () => {
      const result = await startPayment(priced.input);
      if (result.ok) {
        // Stripe Checkout is hosted off-site, so this is a full navigation
        // rather than a router push.
        window.location.assign(result.url);
        return;
      }
      setError(result.errors.form ?? "That listing can no longer be taken. Check it and retry.");
    });
  }

  return (
    <div className="flex flex-wrap gap-3 bg-plate p-2">
      <div className="min-w-[280px] flex-[1_1_340px]">
        <CheckoutForm
          onQuote={(next) => {
            setPriced(next);
            setError(null);
          }}
        />
      </div>
      <div className="min-w-[260px] flex-[1_1_300px]">
        {priced ? (
          <>
            <Receipt quote={priced.quote} onTake={take} pending={pending} />
            {error && (
              <Plate
                surface="note"
                className="text-md mt-2 border-2 px-3 py-2 shadow-none"
                role="alert"
              >
                {error}
              </Plate>
            )}
          </>
        ) : (
          <div className="text-md bg-paper p-3 text-ink-soft">
            Fill in the listing and the receipt appears here.
          </div>
        )}
      </div>
    </div>
  );
}
