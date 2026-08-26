# topnow.live

Pay-to-rank leaderboard where the top three slots are rented by the hour, not bought.
When the meter runs out, the slot frees up.

No cumulative bidding. No permanent number one.

---

## Where things are

| Path                   | What it is                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `TopNow.html`          | The standalone prototype — **binding visual and behavioural reference** |
| `reference/`           | The prototype's DOM and logic, extracted so they can be read and diffed |
| `docs/build-prompt.md` | The build brief. Authority for scope and pricing                        |
| `docs/PLAN.md`         | Phase ordering, dependencies, and the resolved decisions                |
| `src/`                 | The app                                                                 |
| `prisma/`              | Schema and migrations                                                   |
| `e2e/`                 | Playwright specs, run at 360 / 768 / 1280                               |

Work is tracked as [issues](https://github.com/meemimos/topnow.live/issues) — 26 of them,
grouped into six phases in `docs/PLAN.md`. One issue at a time.

## The one rule that matters

**Never fabricate activity, prices, or counts.** No seeded events, no replayed history to
fill quiet periods, no synthetic candles, no rounded-up online counts. The credibility of
the chart, the tape and the surge all rest on the numbers being real.

The prototype's data _is_ fabricated — it is a mockup. Take its layout and its voice, not
its numbers. See `reference/README.md`.

## Setup

**Prerequisites:** Node 22+, npm 10+, PostgreSQL 16+.

```bash
# 1. Install
npm install

# 2. Database
createdb topnow
psql -c "CREATE ROLE topnow LOGIN PASSWORD 'topnow' CREATEDB;"
psql -c "ALTER DATABASE topnow OWNER TO topnow;"

# 3. Environment
cp .env.example .env.local     # then fill it in

# 4. Schema
npm run db:migrate             # creates and applies migrations

# 5. Run
npm run dev                    # http://127.0.0.1:3000
```

There is **no seed data and there never will be** — see the rule above.
`npm run db:seed` exists only to confirm the schema is applied and the database
is empty.

`GET /api/health` reports whether the database connection is live.

## Scripts

| Command                           | What it does                       |
| --------------------------------- | ---------------------------------- |
| `npm run dev`                     | Development server                 |
| `npm run build` / `npm start`     | Production build and serve         |
| `npm run typecheck`               | Route typegen, then `tsc --noEmit` |
| `npm run lint:eslint`             | ESLint                             |
| `npm run format` / `format:check` | Prettier                           |
| `npm test`                        | Unit tests (Vitest)                |
| `npm run test:e2e`                | End-to-end tests (Playwright)      |
| `npm run db:migrate`              | Create and apply a migration       |
| `npm run db:deploy`               | Apply migrations (deploy)          |
| `npm run db:studio`               | Prisma Studio                      |

CI runs format, lint, typecheck, unit tests, build and e2e on every push and pull request,
plus a secret scan. All of it must be green to merge.

## Scenarios

`npm run scenarios` drives the real pricing engine, cap, state machine and sampler
against a database and prints what actually happens across a series of purchases —
a queue building, the cap refusing a buyer, decay after a busy spell, a takedown
mid-rental, a promotion race, and a week of market data.

Every figure it prints comes from the real modules. Nothing in it is illustrative.

**It truncates the database it runs against**, so point it at a scratch one:

```bash
createdb topnow_scenarios
DATABASE_URL="postgresql://topnow:topnow@127.0.0.1:5432/topnow_scenarios" npm run scenarios
```

## Notes for contributors

**Prisma 7** no longer takes a connection URL in `schema.prisma`. The CLI reads it from
`prisma.config.ts`; the runtime client connects through the driver adapter in `src/lib/db.ts`.
`getDb()` is lazy so that `next build` needs no database URL.

**The schema's constraints are load-bearing.** `purchase_one_live_per_slot` — a partial
unique index — is what makes concurrent promotion safe in
[#1](https://github.com/meemimos/topnow.live/issues/1) without application locks. None of
the constraints in the migration may be relaxed into an application-level check.

**Configuration** is read through `src/lib/config`, never `process.env` directly, which
ESLint enforces. The server refuses to boot on a missing or malformed variable and names it.

**Playwright browsers.** In the dev container Chromium is preinstalled under
`/opt/pw-browsers` and `playwright.config.ts` points at it directly. **Do not run
`playwright install` there.** CI installs its own copy.

**Two project lint rules are enforced in CI**, not by review:

- **no raw hex colours in components** — use a design token. Catches both inline styles and
  Tailwind arbitrary values like `text-[#c40000]`.
- **no bare `process.env`** outside `src/lib/config` — configuration is validated at boot.

**Colour discipline is a hard rule.** Green and red mean price direction on the chart and
nowhere else. Time is amber. A price premium is a multiplier (`1.70× base`), never a colour.
Surge urgency comes from weight, size and a black plate — not from red.

**Bevels**: plates are 2px, controls are 3px. The build prompt specifies 3px for both; the
prototype uses 2px on plates and 3px on buttons. The prototype is binding for visuals.

**Focus rings are amber**, not the navy the build prompt specifies — navy on a navy primary
button is invisible, and the primary is the control that most needs a visible ring.

**The shadcn registry (`ui.shadcn.com`) is unreachable** from this environment's network
policy, so `npx shadcn add` will fail. `components.json` and `cn()` are configured, and the
Radix packages the primitives are built on are installed — so primitives can be authored
directly against Radix, which is what a shadcn component is. See
[#4](https://github.com/meemimos/topnow.live/issues/4).

## Licence

MIT — see `LICENSE`. Charts by [TradingView](https://www.tradingview.com/lightweight-charts/);
attribution is a licence requirement, not a courtesy.
