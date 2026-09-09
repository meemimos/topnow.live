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

| #   | Issue                                                                       | Label    |
| --- | --------------------------------------------------------------------------- | -------- |
| 25  | Next.js + TypeScript scaffold, lint/test/CI                                 | `infra`  |
| 23  | Environment config and secret handling                                      | `infra`  |
| 21  | Schema and migrations (the single `purchase` table)                         | `infra`  |
| 4   | Design tokens and primitives (Plate, TitleBar, BevelButton, shadcn retheme) | `design` |

### Phase 1 — Domain core

The parts that must be correct before anything renders a number.

| #   | Issue                                                     | Label   | Depends on |
| --- | --------------------------------------------------------- | ------- | ---------- |
| 2   | Pricing engine — surge, decay, total, as one pure module  | `core`  | 21         |
| 24  | Queued-hours cap per slot                                 | `core`  | 2, 21      |
| 1   | Slot state machine — expiry, promotion, concurrency       | `core`  | 21, 24     |
| 3   | Server-authoritative time and countdown/go-live estimates | `core`  | 1          |
| 22  | Scheduled job for decay sampling and side effects         | `infra` | 1, 2       |

### Phase 2 — Board and purchase

The revenue path. Nothing here fabricates anything; empty states are real states.

| #   | Issue                                                | Label      | Depends on |
| --- | ---------------------------------------------------- | ---------- | ---------- |
| 6   | The board — slot 01 structurally distinct from 02/03 | `ui`       | 4, 1       |
| 7   | The countdown treatment — meter panel, depletion bar | `ui`       | 4, 3       |
| 8   | Checkout flow — platform before handle               | `ui`       | 4, 2       |
| 10  | Queue position before payment                        | `ui`       | 8, 3       |
| 9   | Receipt rendering of checkout                        | `ui`       | 8, 2       |
| 26  | Stripe payment + webhook-driven purchase creation    | `payments` | 1, 2, 8    |

### Phase 3 — Ledger and market

Corroboration, not the sales pitch. Renders below the board.

| #   | Issue                            | Label | Depends on |
| --- | -------------------------------- | ----- | ---------- |
| 11  | Merged queue/tape ledger         | `ui`  | 4, 1       |
| 13  | Sparse and flat market states    | `ui`  | 4          |
| 12  | Price chart — Lightweight Charts | `ui`  | 13, 22     |
| 14  | Pricing dialog                   | `ui`  | 4, 2       |

### Phase 4 — Real signals

Everything here reports a real number or renders nothing.

| #   | Issue                                        | Label    | Depends on |
| --- | -------------------------------------------- | -------- | ---------- |
| 19  | Server-side avatar resolution with caching   | `safety` | 21         |
| 20  | Post embed for slot 01 with profile fallback | `ui`     | 6, 19      |
| 15  | Visitor and online-now counters              | `ui`     | 4, 21      |
| 16  | Activity ticker — real events only           | `ui`     | 4, 1       |

### Phase 5 — Safety and launch gate

Blocks launch. Not optional, not "after".

| #   | Issue                                                    | Label    | Depends on    |
| --- | -------------------------------------------------------- | -------- | ------------- |
| 17  | Takedown flow and admin kill switch                      | `safety` | 1, 21         |
| 18  | Rate limiting on checkout creation and avatar resolution | `safety` | 8, 19         |
| 5   | Visual fidelity pass at 360 / 768 / 1280                 | `design` | all UI issues |

---

## Quality floor — every issue

Restated from the build prompt; an issue is not done without all five.

- Responsive to 360px.
- Visible keyboard focus on every control.
- `prefers-reduced-motion` respected — clocks still tick, nothing else animates.
- `font-variant-numeric: tabular-nums` on every number that changes.
- No raw hex values in any component; tokens only.

---

## Decisions — resolved 2026-08-25

### D1. `topnow-spec.md` is missing — RESOLVED: proceed on the build prompt

The build prompt names it as the source of truth and says the spec wins any conflict.
It is not in the repo and was not supplied. **`docs/build-prompt.md` is the authority.**
If the spec surfaces later, every figure in phase 1 is reconciled against it before phase 2 begins.

### D2. Surge coefficient — RESOLVED: queued hours, cap 18h

Gates #2 and #24.

```
multiplier = 1 + min(queued_hours / QUEUE_CAP_HOURS, 1.0)
QUEUE_CAP_HOURS = 18
```

Surge is driven by **total queued hours**, not head count, and shares its constant with the
wait cap in #24 — a slot at 18 queued hours is at 2.0x and about to stop accepting bookings,
so the multiplier is a direct readout of how close the slot is to closing. One constant, two jobs.

**Amendment (#24): the cap is on the wait, not on the queue.** Capping `queued + requested`
makes the 24h duration unbuyable outright, since 0 + 24 already exceeds 18. A booking is
therefore refused when the hours _already_ queued exceed the cap — your own booking is not
part of your own wait. Consequence: total queued hours can reach 18 + 24 = 42 in the worst
case, during which the slot sits at its 2.0x ceiling and refuses everyone. Nobody in that
queue ever joined a wait longer than 18 hours.

At the prototype's own queue depth (12 queued hours on slot 01) this gives **1.67x / $8.33/hr**
against the mockup's 1.7x / $8.50 — the artwork's headline number without art-directing the formula.

Consequences to carry through:

- #24's cap is no longer an independent constant; it _is_ `QUEUE_CAP_HOURS`.
- #14's "how surge moves" copy must describe queued hours. The prototype's wording assumes
  head count and needs rewriting.
- Maximum wait at the point of joining is bounded at 24 hours, and that is the number stated
  in the pricing dialog.

### D3. Launch-day chart — RESOLVED: hold behind a flag until 20h of trading

Gates #12.

The market panel is **absent at launch** and revealed once a slot has twenty hours of real
trading. #13 is still built and still ships — it is the state the flag flips into, and the
panel enters it whenever a slot is thin, not only at launch.

Consequences to carry through:

- The flag is an environment variable owned by #23.
- #14's chart-legend section hides with the panel.
- #12 moves behind #13 in priority; #13 is the launch-day market state.
- Reveal criterion is twenty hours of _sampled ask_ on a slot (#22), not twenty sales.

### D4. Refunds on a killed rental — RESOLVED: none

Gates #17, and was the last open launch blocker.

A takedown forfeits the remaining hours. Decided by @meemimos on 2026-09-04 and
recorded on the issue.

Consequences to carry through:

- No Stripe refund call on a kill, so no partial-refund path and no reconciliation
  between the ledger and Stripe's refund objects.
- **The forfeit must be stated up front** — in the terms and at checkout — not discovered
  at takedown time. A rule nobody was told about is a worse outcome than the refund itself.
- The ledger already files a killed rental under ENDED with its window closed, so the tape
  stays truthful with no extra work.
- Because there is no money back, the takedown is the entire remedy, which raises the bar
  on it being deliberate. #17 records a reason on the row so a kill can be explained later.

### D5. #20 needed a post URL that nothing collected — RESOLVED: added to checkout

A listing carries a **profile** handle; oEmbed takes a **post** URL. Nothing in #8 or #21
collected one, so #20 as specified had nothing to resolve.

Resolved by adding an optional post link to checkout for the three platforms with a public
oEmbed endpoint (YouTube, TikTok, Reddit), carried through the Stripe session metadata to a
new `purchase.postUrl` column. It is the smallest change that makes the embedded post panel
possible at all, and it is the only URL in the product a buyer types rather than one the
product derives — so it is validated against the platform's own hosts and a post-shaped
path before it is ever sent anywhere.

### D6. The admin surface's default is off — RESOLVED

Gates #17.

`/admin`, `/admin/login` and every admin API route answer **404** until `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` are all set.

The alternative — a panel that exists but refuses a default password — is one that ships
reachable the first time somebody forgets a variable, and "not configured" must never be a
more forgiving state than "not signed in".

The password is stored as a scrypt hash, so a leaked deployment config is a hash to attack
offline rather than a working credential — and the hash is validated at boot, because one
this app cannot parse still reads as "configured" and locks the operator out permanently
with nothing in the logs.

The fixture in `.env.example` is **commented out**. The setup step is
`cp .env.example .env.local`, so an uncommented fixture is what a fresh deployment actually
runs with — and a published `ADMIN_SESSION_SECRET` is worse than a published password: a
public signing key mints valid cookies without going near the sign-in form or its limit.
Review of #31 caught that; it had defeated the whole point of this decision.

### D7. The hash is `:`-separated base64url, not the conventional `$` form — RESOLVED

Next.js expands `$NAME` when it loads a `.env` file, so `scrypt$16384$8$1$…` arrives as
`scrypt6384…` — every `$1`, `$8` and `$p` replaced by an empty variable. The only symptom is
that the correct password stops working, and it failed exactly that way here before the
format changed. Nothing in `:` or base64url is special to a shell or a dotenv loader.

The same trap applies to any value in `.env`: a literal `$` is read as a variable.

### D8. Rate limiting is Postgres-backed, not Redis — RESOLVED

Gates #18, whose requirement is shared storage rather than per-instance memory.

Postgres is the shared store TopNow already runs. Redis would be faster and is the usual
answer; adding a second stateful dependency to the deployment, for four endpoints that are
not hot paths, is an operational cost paid for latency nobody is measuring.

The algorithm is GCRA rather than a fixed window, because a fixed window permits twice the
limit across a boundary and its `Retry-After` is wrong for everyone who arrives mid-window.

## Settled — tape ordering

`docs/build-prompt.md` specifies `tape = status = ended, ordered by bought_at descending`,
and #11 describes the same section as "ended (newest first) — the tape". With mixed durations
those two can disagree: a 24h rental bought at 9am ends a day later, yet sorts _below_ a 1h
rental bought at 10am that ended at 11am.

**Resolved by #11's own spec**, which states the ordering per section and requires the section
headers to explain the reversal: the queue reads `bought_at` **ascending** because the oldest
purchase goes live next, and the tape reads `bought_at` **descending** because that is how a
tape reads. Both orders are over `bought_at`, which is what #21 already indexes.

Implemented that way in `buildLedger`, with the copy carrying the explanation — an unexplained
reversal inside a single table reads as a sorting bug, which is the actual risk here.

## Standing pushback

Registered against the build prompt's "Things I want you to push back on":

1. **A scheduled job is the wrong mechanism for expiry.** Liveness should be _derived_ from
   timestamps at read time, not written by a cron. See issue #1.
2. **The chart may not have enough data to be meaningful — now measured, not speculated.**
   A simulated realistic first week (13 purchases across three slots) left every slot **0% of
   the week above base**: purchases go live immediately rather than queueing, so surge never
   fires and the chart is three flat lines. Raised with @meemimos, who chose to build #12 as
   specified anyway. Revisit once there is real traffic to judge.
3. **Decay has nothing to decay** if surge is a pure function of the current queue. The ask
   needs memory for decay to mean anything. See issue #2.
4. **Only GitHub can resolve an avatar without credentials.** YouTube needs a Data API key,
   Instagram and TikTok need authenticated tokens, and Reddit refuses unauthenticated profile
   reads from datacentre addresses. Those platforms render the designed placeholder with the
   reason recorded (#19). Inventing a likeness — a silhouette, a colour derived from the
   handle — would be fabrication. The pipeline is unchanged the day a key exists.
5. **No provider reports a view count in an oEmbed response.** Not YouTube, not TikTok, not
   Reddit. So slot 01's footer usually shows clicks alone, and the views row is simply absent
   (#20). Clicks are TopNow's own measurement, which is why they are the count it prints.
6. **"Looking at slot 01 right now" is not measurable** without instrumenting scroll position
   per visitor. The line says "on the board right now" instead (#15) — the prototype's panel
   shape with a claim the server can stand behind.
7. **A per-IP rate limit is only as good as the address it keys on.** `x-forwarded-for` is
   client-writable at the left-hand end, so the limiter reads it from the **right**, counting
   `RATE_LIMIT_TRUSTED_PROXIES` hops back. Set that wrong and the limit is either trusting
   client-supplied text or bucketing everybody behind the proxy together — only the deployment
   knows the answer, so it is configuration rather than a guess (#18).

   Corrected after review: `0` is now a valid value, meaning no proxy and therefore no knowable
   address. It had been unrepresentable, so a deployment with nothing in front of it dropped
   every visitor into one shared bucket and refused the sixth checkout **site-wide**. Where no
   address can be established, checkout now warns and lets the buyer through — the queued-hours
   cap (#24) already bounds queue-flooding, and a limiter that turns a misconfigured header into
   a closed shop is worse than none. The report endpoint and admin sign-in keep the shared
   bucket, because neither has a backstop and a degraded limit beats an open one.

8. **A server action cannot return a 429.** Its response is a return value, not a status line.
   So checkout's limit renders the product's error treatment (which is what a person needs),
   and the endpoints that are genuinely machine-consumed — `/api/report`, admin sign-in —
   return a real 429 with a real `Retry-After` (#18).
9. **Nothing at checkout can prove a buyer owns the handle they typed.** No platform offers
   that check without an authenticated integration, and asking for a login would put an
   account wall in front of a product whose whole pitch is that there is no account. So
   ownership is enforced after the fact: a report path on every listing, and a takedown (#17).
   That is the honest design, not a gap in it.
