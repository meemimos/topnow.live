# TopNow — build plan

Source of authority, in order: `topnow-spec.md` (**missing from the repo — see Open decisions**),
then `docs/build-prompt.md`, then `TopNow.html` for anything visual.

Work is one issue at a time, one branch per issue, review before the next.

---

## Phases

Each phase is a gate: nothing in phase N+1 starts until phase N's issues are merged,
because the later phases consume the earlier ones' outputs (tokens, pricing engine, state machine).

### Phase 0 — Foundation
No product behaviour. Everything after this depends on all of it.

| # | Issue | Label |
|---|---|---|
| 25 | Next.js + TypeScript scaffold, lint/test/CI | `infra` |
| 23 | Environment config and secret handling | `infra` |
| 21 | Schema and migrations (the single `purchase` table) | `infra` |
| 4 | Design tokens and primitives (Plate, TitleBar, BevelButton, shadcn retheme) | `design` |

### Phase 1 — Domain core
The parts that must be correct before anything renders a number.

| # | Issue | Label | Depends on |
|---|---|---|---|
| 2 | Pricing engine — surge, decay, total, as one pure module | `core` | 21 |
| 24 | Queued-hours cap per slot | `core` | 2, 21 |
| 1 | Slot state machine — expiry, promotion, concurrency | `core` | 21, 24 |
| 3 | Server-authoritative time and countdown/go-live estimates | `core` | 1 |
| 22 | Scheduled job for decay sampling and side effects | `infra` | 1, 2 |

### Phase 2 — Board and purchase
The revenue path. Nothing here fabricates anything; empty states are real states.

| # | Issue | Label | Depends on |
|---|---|---|---|
| 6 | The board — slot 01 structurally distinct from 02/03 | `ui` | 4, 1 |
| 7 | The countdown treatment — meter panel, depletion bar | `ui` | 4, 3 |
| 8 | Checkout flow — platform before handle | `ui` | 4, 2 |
| 10 | Queue position before payment | `ui` | 8, 3 |
| 9 | Receipt rendering of checkout | `ui` | 8, 2 |
| 26 | Stripe payment + webhook-driven purchase creation | `payments` | 1, 2, 8 |

### Phase 3 — Ledger and market
Corroboration, not the sales pitch. Renders below the board.

| # | Issue | Label | Depends on |
|---|---|---|---|
| 11 | Merged queue/tape ledger | `ui` | 4, 1 |
| 13 | Sparse and flat market states | `ui` | 4 |
| 12 | Price chart — Lightweight Charts | `ui` | 13, 22 |
| 14 | Pricing dialog | `ui` | 4, 2 |

### Phase 4 — Real signals
Everything here reports a real number or renders nothing.

| # | Issue | Label | Depends on |
|---|---|---|---|
| 19 | Server-side avatar resolution with caching | `safety` | 21 |
| 20 | Post embed for slot 01 with profile fallback | `ui` | 6, 19 |
| 15 | Visitor and online-now counters | `ui` | 4, 21 |
| 16 | Activity ticker — real events only | `ui` | 4, 1 |

### Phase 5 — Safety and launch gate
Blocks launch. Not optional, not "after".

| # | Issue | Label | Depends on |
|---|---|---|---|
| 17 | Takedown flow and admin kill switch | `safety` | 1, 21 |
| 18 | Rate limiting on checkout creation and avatar resolution | `safety` | 8, 19 |
| 5 | Visual fidelity pass at 360 / 768 / 1280 | `design` | all UI issues |

---

## Quality floor — every issue

Restated from the build prompt; an issue is not done without all five.

- Responsive to 360px.
- Visible keyboard focus on every control.
- `prefers-reduced-motion` respected — clocks still tick, nothing else animates.
- `font-variant-numeric: tabular-nums` on every number that changes.
- No raw hex values in any component; tokens only.

---

## Open decisions — blocking

### D1. `topnow-spec.md` is missing
The build prompt names it as the source of truth for pricing, the purchase model and
launch requirements, and says the spec wins any conflict. It is not in the repo and was
not supplied. **Proceeding on the build prompt as authority.** If the spec surfaces, every
figure in phase 1 must be reconciled against it before phase 2 starts.

### D2. Surge coefficient — gates issue #2
See issue #2 for the full working. Recommendation: drive surge from **total queued hours**,
not head count, and couple it to the queued-hours cap from issue #24 so one number does both jobs.

### D3. Launch-day chart state — gates issue #12
Ship the chart sparse from day one, or hold the market panel behind a flag until a slot has
twenty hours of trading. Not resolvable by generating data.

---

## Standing pushback

Registered against the build prompt's "Things I want you to push back on":

1. **A scheduled job is the wrong mechanism for expiry.** Liveness should be *derived* from
   timestamps at read time, not written by a cron. See issue #1.
2. **The chart may not have enough data to be meaningful.** Three slots produce single-digit
   prints a day. See issues #12 and #13.
3. **Decay has nothing to decay** if surge is a pure function of the current queue. The ask
   needs memory for decay to mean anything. See issue #2.
