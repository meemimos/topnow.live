# TopNow — build prompt for Claude Code

Paste everything below the line into Claude Code, with `topnow-spec.md`, `TopNow.html` (the standalone prototype), and the design-prompt files in the repo.

---

Build **TopNow** (topnow.live): a pay-to-rank leaderboard where the top three slots are rented by the hour rather than bought permanently. When a rental expires the slot frees up. No cumulative bidding, no permanent number one.

There is an existing standalone HTML prototype in the repo (`TopNow.html`). Treat it as the **binding visual and behavioural reference** — it establishes the Web 1.0 aesthetic, copy voice, and interaction model. Rebuild the app properly with real state, real payments, and real persistence, but the rendered result must match the prototype at 360px, 768px, and 1280px. Where you intend to deviate visually, say so and wait.

## Before writing any code

**Read `topnow-spec.md` first.** It is the source of truth for pricing, the purchase model, and the launch requirements. Where this prompt and the spec disagree, the spec wins — tell me about the conflict rather than picking silently.

**Read the "Design system" section below and the prototype's computed styles.** The aesthetic is specific and mechanical; it is not a shadcn theme with rounded corners removed.

**Then create GitHub issues before implementing anything.** One issue per unit of work below, each with a clear acceptance criterion and a label (`core`, `payments`, `ui`, `design`, `safety`, `infra`). Link dependent issues. Post the full list and wait for me to confirm before you start on the first one.

Work one issue at a time. Open a branch per issue, commit against it, and stop for review before moving on. Do not batch several issues into one pass.

## Stack

Next.js (App Router) · TypeScript · Postgres · Prisma · shadcn/ui · Tailwind · Stripe · TradingView Lightweight Charts

Retheme shadcn hard — `--radius: 0`, custom palette, heavier borders, era-appropriate type. Retheme the primitives, do not rebuild them: keep the focus states, keyboard handling, and ARIA they provide.

## Design system — implement this before any screen

These are the exact values in the prototype. Put them in the Tailwind theme and use them by name; no ad-hoc colours anywhere.

| Token | Value | Used for |
|---|---|---|
| `ground` | `#008080` | page background (the desktop) |
| `plate` | `#c6c6c6` | panel chrome |
| `plate-light` / `plate-dark` | `#ffffff` / `#7b7b7b` | bevel highlight / shadow |
| `well` | `#e6e6e6` | inset strips, table headers |
| `paper` | `#ffffff` | content surfaces |
| `ink` | `#000000` | text, all borders |
| `navy` | `#000080` | title bars, primary buttons, sale markers |
| `navy-light` / `navy-dark` | `#5b5bd6` / `#00003f` | navy bevel pair |
| `note` | `#ffffcc` | callouts, live rows, highlighted values |
| `meter` | `#ffb000` | all time and meter readouts |
| `meter-bright` | `#ffd166` | ticking seconds |
| `up` / `down` | `#00a000` / `#c40000` | **chart only** — candle direction |

- Type: Verdana/Geneva for prose, **Silkscreen** (Google) for every label, numeral readout, and button. Two families, nothing else.
- Radius: `0` everywhere. Borders `1px solid #000` on plates, `2px` on notes, `3px dashed` on empty/available states.
- Bevel recipe (raised): `border: 1px solid ink; box-shadow: inset -3px -3px 0 plate-dark, inset 3px 3px 0 plate-light`. Pressed/`:active` inverts the two insets. Inset wells swap them permanently.
- Build three primitives and compose everything from them: **Plate** (bevelled panel), **TitleBar** (navy header strip with right-aligned meta), **BevelButton** (silver default, navy primary, inverts on active).

**Colour discipline is a hard rule.** Green and red mean price direction on the chart and nowhere else. Time uses `meter` amber. A price premium is expressed as a multiplier (`1.70× base`), never as colour. Surge urgency comes from weight, size, and a black plate — not from red.

**Quality floor, applies to every issue:** responsive to 360px; visible keyboard focus on every control; `prefers-reduced-motion` respected (clocks still tick, nothing else animates); `font-variant-numeric: tabular-nums` on every number that changes.

## The model

One table drives everything. A queue entry and a completed sale are the same record at different points in its life.

```
purchase
  id
  slot          1 | 2 | 3
  handle
  platform      github | youtube | instagram | tiktok | reddit | web
  display_name  (website only)
  target_url    derived from platform + handle, or supplied for websites
  tagline       max 60 chars
  duration_h    1 | 3 | 6 | 12 | 24
  price_hr      the ask at checkout, locked
  total_paid
  bought_at     this is the print on the chart
  starts_at     null until promoted
  ends_at       starts_at + duration_h
  status        queued | live | ended | killed
```

Derived views, never separate tables:

- board = `status = live`
- queue = `status = queued`, ordered by `bought_at` ascending
- tape = `status = ended`, ordered by `bought_at` descending
- chart = `price_hr` plotted against `bought_at`

## Pricing

Flat hourly rate per slot. **total = base_rate x surge x hours.** No volume discount, no duration premium — a discount would reward exactly the squatting this model exists to prevent, and would break the chart by moving price independently of demand.

| Slot | Base |
|---|---|
| 01 | $5.00/hr |
| 02 | $3.00/hr |
| 03 | $2.00/hr |

Durations are snap points: 1h / 3h / 6h / 12h / 24h.

**Surge**, per slot, on that slot's own queue:

```
multiplier = min(1 + 0.03 * queue_length, 2.0)
```

Continuous, capped at 2x, **locked at checkout**. Nobody already queued is ever re-priced.

**Decay**: a slot unsold for an hour drops its ask 5% toward base. Without decay the price only ratchets up and never behaves like a market.

Every displayed figure must derive from one calculation. No hardcoded totals anywhere.

**Open conflict — resolve with me in issue 2, do not pick silently.** The prototype shows slot 01 at 1.7× / $8.50 per hour. The formula above returns 1.12× with four in the queue, so with only three slots the multiplier will sit near base almost permanently and surge — the loudest element in the design — will effectively never appear. Three options to price out: raise the coefficient; drive surge from total *queued hours* rather than head count; or accept surge as a rare event and make the calm state the design default. Come back with a recommendation and the numbers behind it.

## Issues to create

### Core
1. **Slot state machine** — expiry, queue promotion, and the `queued -> live -> ended` transition. This is where the real complexity lives: what happens when two checkouts land on the same slot in the same instant, when a promotion fires while a payment is pending, when the server restarts mid-rental. Solve it with database-level guarantees, not application locks. Everything else is presentation.
2. **Pricing engine** — surge, decay, and total calculation as one pure module with unit tests. Every price shown anywhere in the app calls this. Includes the surge-coefficient decision above.
3. **Countdown and go-live estimates** — server-authoritative time, never client clock.

### Design
4. **Design tokens and primitives** — the table above as Tailwind theme values, plus Plate, TitleBar, BevelButton, and the retheme of every shadcn primitive the app uses (`--radius: 0`, focus rings in navy, no default greys left). *Acceptance: a kitchen-sink page renders all primitives and no component in the app declares a raw hex value.*
5. **Visual fidelity pass** — side-by-side against `TopNow.html` at 360 / 768 / 1280, checked into the repo as screenshots. *Acceptance: spacing, type sizes, bevels, and colour usage match; any deviation is listed with a reason.*

### UI
6. **The board** — slot 01 structurally distinct from 02 and 03 (wider card, large avatar, embedded post). If 01 and 02 render as the same component at different sizes, the price tiers have no visible justification and nobody pays the premium.
7. **The countdown treatment** — black meter panel, amber digits at the prototype's scale, brighter ticking seconds, striped depletion bar showing proportion of the rental left. This is the product's engine; it gets the boldest type on the page. *Acceptance: legible and unmissable at 360px; keeps ticking under reduced-motion.*
8. **Checkout flow** — platform selected *before* handle (platform determines the handle's validation and prefix). No separate link field; derive it and show it as read-only helper text. Website is the exception and needs a display-name field (24 chars). Tagline capped at 60 with a live counter.
9. **Receipt rendering of checkout** — the ticket/receipt panel from the prototype: dashed rules, effective rate on the line item (`3H AT $8.50/HR`), the derivation beneath it (`$5.00 BASE × 1.7 SURGE × 3H`), total in large tabular type, and a button that states what happens (`Take slot 01 — $25.50`).
10. **Queue position before payment** — position, estimated go-live, and only then the end time. Never show "yours until 7:39 PM" to someone who is fourth in line.
11. **Merged queue/tape ledger** — three sections, one dataset: on the board now / in the queue (oldest first) / ended (newest first). That reversal is correct and section headers must make it legible. Columns: handle + platform tag, slot, duration, $/hr, paid, bought, status badge with the relevant clock. Live rows highlighted, ended rows recede. *Acceptance: at 360px the slot and bought columns drop rather than the table scrolling sideways.*
12. **Price chart** — Lightweight Charts, hourly candles from the sampled ask, purchases as navy markers, base rate as a dashed reference, filled candles up and hollow down so direction survives greyscale. Ticker strip above (slot, current ask, change vs base) that switches the chart and doubles as the summary once the chart is scrolled past. Ranges 12H / 24H / 48H / 5D. Place it **below the board and the ledger** — it corroborates the board, it does not sell the slot. Run `npx skills add https://github.com/tradingview/lightweight-charts` first; the v4-to-v5 API changed and stale examples produce broken code. Attribution to TradingView is a licence requirement, not optional — give it a deliberate home in the panel footer. *Acceptance: under 620px the chart collapses to a sparkline with a "show full chart" control.*
13. **Sparse and flat market states** — below roughly twenty candles, show the ticker and the ledger and replace the chart with an honest note ("market is still opening, N sales so far"). A slot sitting at base for six hours reads as *available at base*, not as broken. Never interpolate, never pad, never draw a flat line dressed up as activity.
14. **Pricing dialog** — base / surge / ask-now per slot from the pricing engine, the flat-rate rule stated plainly, how surge moves, and the chart legend (filled green, hollow red, navy dot, dashed base line).
15. **Visitor and online-now counters** — cached, updated on an interval, never a live query per request. Rendered as the prototype's hit counter: zero-padded seven-digit odometer that rolls per digit, and a small amber LCD for online-now that floors at the real number. *Acceptance: a real 3 shows as `003`; no rolling under reduced-motion; no layout shift across a digit boundary.*
16. **Activity ticker** — real events only.

### Safety
17. **Takedown flow and admin kill switch** — required before launch, not after. Nothing currently stops someone listing a handle they do not own, and on a paid board that is legal exposure rather than a matter of taste.
18. **Rate limiting** on checkout creation and avatar resolution.
19. **Server-side avatar resolution with caching** — resolve once at submission, store our own copy, serve from there. Calling a third-party avatar proxy from the browser on every keystroke will get rate-limited immediately and breaks entirely when that service is down.
20. **Post embed for slot 01 with profile fallback** — YouTube, TikTok, and Reddit oEmbed. If the embed fails to resolve at render time the card degrades silently to the profile link. Never show a dead card at #1.

### Infra
21. Schema and migrations.
22. Scheduled job for expiry, promotion, and decay.
23. Environment config and secret handling — env vars from the first commit, never added later.
24. **Queued-hours cap per slot** — a hard ceiling on total queued hours so nobody can buy a position with a multi-day wait.

## Things I want you to push back on

If any of the following is true as you build, say so rather than implementing around it:

- The chart has too little data to be meaningful. Three slots produce a handful of prints a day, and slots 02 and 03 may never surge enough to move. If the sparse state looks broken, tell me — the honest fix may be dropping the chart, not padding it.
- A scheduled job is the wrong mechanism for expiry at this precision.
- The queue can grow unbounded (see issue 24).
- The surge coefficient makes surge invisible in practice (see Pricing).

## Launch-day reality — decide before issue 12

Because nothing may be fabricated, on day one the chart sits in its sparse state, the ledger is nearly empty, and the counters are small. That is correct and it is not what the prototype screenshots show. Tell me which you want: ship the chart in its sparse state from day one, or hold the market panel behind a flag until a slot has twenty hours of trading. I will decide; do not resolve it by generating data.

## Non-negotiable

**Never fabricate activity, prices, or counts.** No seeded events, no replayed history to fill quiet periods, no synthetic candles, no rounded-up online counts. The credibility of the chart, the tape, and the surge all rest on the numbers being real, and this audience will spot one fake line and discount everything else on the page.

## First response

Post the issue list with acceptance criteria and dependencies. Do not write code yet.
