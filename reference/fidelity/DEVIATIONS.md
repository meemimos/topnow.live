# Deviations from the prototype

**Issue [#5](https://github.com/meemimos/topnow.live/issues/5).** `TopNow.html` is the binding
visual reference. This file lists every difference between it and the built app, with the reason.
An unexplained difference is a bug; an explained one is a decision.

Regenerate the captures with:

```bash
NEXT_PUBLIC_MARKET_PANEL_ENABLED=true npm run build && npm start &
npm run fidelity
```

## What is in here

| File                            | What it is                                      |
| ------------------------------- | ----------------------------------------------- |
| `prototype-<width>.png`         | `TopNow.html`, full page                        |
| `prototype-<panel>-<width>.png` | one panel of the prototype                      |
| `app-<width>.png`               | the built board, full page, with a seeded board |
| `app-<panel>-<width>.png`       | one panel of the built board                    |
| `app-checkout-<width>.png`      | the built checkout, full page                   |
| `app-empty-<width>.png`         | the built board **with nothing on it**          |

Widths are 360, 768 and 1280. Panels are board, ledger, market, meter and receipt.

## Read the pairs for chrome, not for content

The prototype's board, ledger and chart are fabricated — `buildMarket`, `LIVE`, `QUEUED` and
`ENDED_HANDLES` in `../prototype-logic.js`. The app renders real rows. The capture script seeds a
fixed board through the real pricing engine so the two are comparable at all, and clears it again
before it exits; the `app-empty-*` set is what a real launch day looks like.

**Compare spacing, type, bevels and colour usage. Do not compare how much content there is.**

---

## Fixed by this pass

Found by putting the two side by side, and changed rather than justified.

| What                                                                                | Why it was wrong                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Window chrome was missing** — no title bar, no status strip, no bottom status bar | The app read as three panels floating on a teal ground; the prototype frames the whole product as an application window. Added in `src/components/ui/site-chrome.tsx`, with every value real: the open-slot count comes from the board being rendered, the server time from the clock every countdown reads (#3), the platform list from the table the board uses. |
| **"01 — PAY / 02 — RUN / 03 — EXPIRE" was missing**                                 | The model is unusual enough that the three states need naming. It sits at the bottom, after the board has been seen doing it.                                                                                                                                                                                                                                      |
| **`PAY FOR TIME` was navy on navy**                                                 | Unlayered `a { color: #0000ee }` in `globals.css` beat `text-paper` — unlayered CSS wins over _every_ cascade layer regardless of specificity. The base rules are now in `@layer base`, and buttons set `no-underline`. This was a legibility bug, not a nuance.                                                                                                   |
| **Slot 01's profile card stretched to the meter's height**                          | With no embedded post — which is most listings — that left a tall empty panel beside a full column. The row is `items-start` now, so the card ends where its content ends.                                                                                                                                                                                         |
| **The surge note was a pale yellow plate**                                          | The prototype's is a black plate with a bordered `SURGE` badge, and the repo's own rule is that surge urgency comes from weight, size and a black plate rather than from colour.                                                                                                                                                                                   |
| **Checkout's slot buttons were small**                                              | Three narrow buttons at the left read as a filter. The prototype fills the column, which reads as the choice the step is asking.                                                                                                                                                                                                                                   |
| **Checkout's duration slider sat bare on paper**                                    | The prototype puts the track in an inset well. It was the one control on the page that stopped looking like the rest of it.                                                                                                                                                                                                                                        |

---

## Deviations kept, with reasons

### Content the app cannot show, and will not invent

1. **No embedded post on slot 01.** The prototype's slot 01 carries an `EMBEDDED POST` panel with
   `POST MEDIA` and a `4,126 views · 318 clicks` footer. The app renders that panel only when the
   listing has a post URL that a provider actually resolved (#20). The seeded fixture has none,
   and no provider is reachable from this environment. Slot 01 is then the profile card, which is
   a complete state rather than a hole.

2. **No view count, ever.** None of YouTube, TikTok or Reddit puts a view count in an oEmbed
   response. Clicks are TopNow's own measurement and are printed; views are absent rather than
   guessed (#20, standing pushback 5 in `docs/PLAN.md`).

3. **Avatars are placeholders.** Only GitHub resolves an avatar without credentials, and this
   environment cannot reach it. The prototype's hatched `AVATAR 78PX` box is a mockup annotation;
   the app's hatched box is the designed empty state (#19).

4. **The counters read differently.** The prototype says _"looking at slot 01 right now"_. That is
   not measurable without instrumenting scroll position per visitor, so the app says _"on the board
   right now — seen in the last 5 minutes"_ (#15). Same panel, a claim the server can stand behind.

5. **The status strip's "server is up" dot is amber, not green.** Green and red mean price
   direction on the chart and appear nowhere else. A green dot in the chrome is exactly the leak
   that rule exists to prevent.

### Surfaces the build added

6. **An activity ticker** sits between the board and the counters (#16). The prototype has no
   equivalent; the build prompt asks for one. Every item traces to a real purchase transition or a
   real hourly sample.

7. **`report this listing`** under every listing's CTA (#17). No prototype counterpart. Quiet and
   last, deliberately: a prominent report button beside a paid listing suggests the board expects
   its listings to be reportable.

8. **The receipt states the takedown forfeit** and links to `/terms` (#17, decision D4). The
   prototype's receipt ends at the meter copy.

9. **`/terms` and `/admin` are new pages.** Neither exists in the prototype.

### Layout the build placed differently

10. **The checkout is one step, not two.** The prototype's `THE METER` panel shows only the slot,
    the duration and a summary; the listing fields are behind `STEP 1 OF 2`. The app puts
    `3 — YOUR LISTING` in the same panel and keeps the `STEP 1 OF 2` label, because the receipt
    beside it prices the listing live and splitting them would mean pricing something not yet
    described (#8).

11. **The queue position sits in the receipt column**, not under the meter as prose. It is part of
    what the buyer is being sold — when they go live — so it belongs beside the total (#10).

12. **The receipt header says `NOT YET PAID`, not a receipt number.** The prototype prints
    `NO. 09221`. There is no receipt number before payment clears, and printing one would be
    printing a fabricated identifier on a document about money.

13. **The ledger's `DUR` column is pixel-font uppercase (`6H`)** where the prototype uses body text
    (`6h`). It is a number that changes, so it carries the same treatment as every other figure in
    the table.

### Not reproduced

14. **The prototype's slot-02 row shows a queue count in its CTA** (`JOIN QUEUE — 3 AHEAD`). The
    app says `JOIN QUEUE FOR 02 — NEXT UP` when nobody is ahead, and names the slot. Both come from
    the same function; the strings differ because the states differ.

---

## Checked and holding

- **No horizontal scroll at 360px** on any panel, on either page. Asserted in the e2e suite as well
  as visible in `app-360.png`.
- **Bevels**: plates 2px, controls 3px, matching the prototype rather than the build prompt's 3px
  for both.
- **Colour discipline**: green and red appear only inside the chart, in every capture at every
  width. The surge treatment is a black plate; time is amber; a price premium is a multiplier.
- **The empty state is designed.** `app-empty-*.png` is the honest launch-day page: three open
  slots at base, a ledger saying so in three sentences, a market panel saying it has not opened
  yet, and counters reading `0000000` — not a spinner and not a placeholder.
