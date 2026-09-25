# TopNow → web3 ad platform

**Status: proposed, not started. Testnet only until @meemimos says otherwise.**

The product does not change shape: three slots, rented by the hour, and when the countdown
hits zero the slot reopens. What changes is who buys them and how they pay — crypto projects,
in USDC, on Base — and what a slot carries: a token, a contract address, a CTA.

This plan is written against the codebase as it stands at
[#31](https://github.com/meemimos/topnow.live/pull/31). Read `docs/PLAN.md` first; the decisions
there (D1–D8) still hold, and several of them constrain what follows.

---

## Where the existing product stands

|               |                                                                               |
| ------------- | ----------------------------------------------------------------------------- |
| **Stack**     | Next.js 16 App Router (RSC), React 19, TypeScript strict, Tailwind 4, Radix   |
| **Data**      | Prisma 7 → PostgreSQL via `@prisma/adapter-pg`                                |
| **Payments**  | Stripe Checkout; the purchase row is created **only** by the verified webhook |
| **Tests**     | Vitest (826 unit, against a real Postgres) + Playwright (289 e2e)             |
| **Deploy**    | Not configured. CI is GitHub Actions only (`verify` + gitleaks)               |
| **Scheduler** | `POST /api/cron/hourly`, authenticated by `CRON_SECRET`                       |

Four properties of the current design matter to everything below.

**Liveness is derived, never written.** A rental is on the board when
`startsAt <= now < endsAt`. No job flips `live → ended`; expiry costs nothing and cannot be
missed. The only genuine write is promotion, guarded by the partial unique index
`purchase_one_live_per_slot` inside a serializable transaction. This is the property a contract
has to preserve — and, happily, the one that makes an O(1) contract possible.

**One table is the whole product.** A queue entry and a completed sale are the same `Purchase`
row at different points in its life (`queued → live → ended`, or `→ killed`).

**Price is locked at purchase and never recomputed.** `multiplier = 1 + min(queued_hours / 24, 1)`,
capped at 2.00×, decaying 5%/hr toward base. A slot stops accepting bookings once
live-remaining + queued exceeds 24h.

**Never fabricate activity, prices, or counts.** From the build prompt, non-negotiable. It
governs the new per-slot stats as strictly as it governs the existing ones.

---

## Decisions — resolved by @meemimos, 2026-09-25

### W1. Chain and token — Base only, USDC only

Base Sepolia for all development. No Solana. USDC only, so there is no price oracle and
therefore no oracle risk; prices stay integer minor units end to end, as they already are.

### W2. Outbidding — not in the MVP

The MVP keeps the queue exactly as it is: no mid-hour takeovers. Outbidding arrives in phase 2,
applies only to the **live** slot, requires **≥10% over the current rate**, and respects a
**15-minute protected window** after a tenant starts. The queue survives an outbid and shifts.

### W3. Custody — contract escrow, earned pro-rata

Payment goes upfront into escrow and is earned as time elapses, so unused time is refundable.
Refunds are **pull-to-claim**, never pushed: a push to an address that reverts is a griefing
vector, and USDC can block an address.

Platform revenue is withdrawable at any time by a **Safe multisig**.

### W4. Pricing — the existing curve, signed offchain

The surge/decay curve stays and continues to be computed offchain. The server issues an
**EIP-712 signed quote** carrying an expiry and a nonce; the contract verifies the signature and
rejects anything expired or replayed. A locked buyer is never re-priced.

**Consequence to carry:** a server that signs quotes can sign `rate = 0`. The contract therefore
enforces a per-slot `minRateHr` floor, so a compromised signer can discount but cannot zero out.
The signer is rotatable.

### W5. Slot content — onchain rental, offchain content, hashed

Logo, name, ticker, contract address, chain, CTA type (Mint/Swap/Join) and CTA URL. No video in
the MVP; if it lands later it is self-hosted, because the board makes **zero third-party
requests** by design (#19, #20) and an embedded player would undo that in one line.

The rental is onchain. The content lives in the database keyed by rental id, with a
`contentHash` stored onchain so the content that was approved is the content that is provable.

### W6. Moderation — before the quote is signed

First-time advertisers are pre-approved by hand (@meemimos staffs it); approved advertisers skip
the queue on later rentals.

**Approval happens before a quote is signed, not after payment.** The server issues no signed
quote for unapproved content, so an unapproved rental cannot be paid for at all. This removes the
refund-on-reject path entirely: there is nothing to refund, because nothing was taken. It also
removes a whole class of awkward state — a paid rental sitting in escrow waiting on a human.

One consequence worth stating plainly: the approval gate is a **dependency of the crypto pay
flow**, not a later addition to it. Phase 2 therefore ships the gate — the quote endpoint refuses
unapproved advertisers and unapproved content — and phase 5 ships the queue UI and the badges.
Between the two, approval is a hand-flipped database column, which is fine for a surface with one
operator.

Admin kill still exists and still refunds unused time. That is for a listing which was approved
and later turned out to be something else.

Automated badges: contract verified (Basescan API), LP lock status. Manual: audit link.

### W7. Auth — both paths stay

Wallet connect for crypto buyers; **Stripe coexists** for fiat buyers. The existing
password-and-session admin stays for the web UI; onchain admin actions go through the Safe.

### W8. Infrastructure

Vercel, Neon, Alchemy. Logs are polled in the existing hourly job rather than indexed by a
subgraph — three slots do not justify an indexer, and the job already exists and is authenticated.

Telegram first for announcements, then X.

### W9. Regulatory — Australia

Legal advice before mainnet. Built in from the start: a disclaimer on every slot, a submission-time
ban on securities-like offerings and yield promises, and an admin-configurable geo-block list.

**Prediction-with-payout is dropped.** Phase 2's viewer rewards are non-monetary points and badges
only. A prediction market with a payout is a materially different regulatory object from an ad
board, and it is not worth carrying.

---

## Three decisions this plan makes

### W10. The contract schedules in O(1), with no loops

A queue, fixed durations and no mid-hour takeover together mean the schedule can be computed
without iterating anything:

```
startsAt = max(now, freeAt[slot])
endsAt   = startsAt + durationH * 1 hours
freeAt[slot] = endsAt
```

Liveness onchain is then derived exactly as it already is offchain — `startsAt <= now < endsAt` —
so there is no promotion transaction, no cron dependency, and no unbounded iteration anywhere.
The existing 24-hour wait cap is one comparison: `freeAt - now <= 24h`.

This is the closest fit between the architecture that exists and a contract, which is why it is
worth keeping the queue in the MVP rather than starting from an auction.

### W11. Fiat rentals are registered onchain — **CONFIRMED (i)**

Fiat and crypto compete for the same three slots, but only the contract knows `freeAt`. A Stripe
purchase is invisible to it, so the two paths would double-book.

| Option                                              | Trade                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(i) Register fiat rentals onchain** — recommended | The webhook calls an owner-only `registerFiat(...)` with zero payment. One authoritative schedule for both paths. Costs a sub-cent transaction per fiat sale, and couples the webhook to a transaction that can fail — mitigated by a retry queue reconciled in the hourly job. |
| (ii) Separate boards                                | No coupling, but "the leaderboard" becomes two leaderboards, which is a worse product.                                                                                                                                                                                          |
| (iii) Drop Stripe                                   | Cleanest contract; loses the fiat buyers W7 keeps.                                                                                                                                                                                                                              |

Confirmed as (i) by @meemimos. The hot key that calls `registerFiat` is scoped by role rather
than by ownership — see W13 — so a compromised web server can schedule a fiat rental and nothing
else. It cannot move funds, change the signer, or change a price floor.

### W12. A kill leaves a hole in the schedule

Killing a **live** rental frees the slot, but rentals behind it keep their scheduled start.
Pulling them forward needs either an unbounded loop (banned) or a per-slot shift accumulator that
gets subtle quickly — a rental that has already started must not be shifted, and the bookkeeping
to know that is exactly the complexity the O(1) design avoids.

The MVP takes the hole and says so in the UI. Phase 2 solves it properly alongside outbidding,
which has the identical "tenant left early" shape.

### W13. Roles, not ownership

`AccessControl` rather than `Ownable2Step`. Three roles, each holding the smallest authority that
lets it do its job:

| Role                 | Holder                    | May                                                                             |
| -------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `DEFAULT_ADMIN_ROLE` | Safe multisig             | `withdraw`, `setQuoteSigner`, `setMinRate`, `setPaused`, grant and revoke roles |
| `REGISTRAR_ROLE`     | hot key on the web server | `registerFiat` — **nothing else**                                               |
| `MODERATOR_ROLE`     | hot key                   | `kill`, and **only before `startsAt`**                                          |

The point of the split is blast radius. The registrar key lives on a web server that talks to
Stripe, so it is the key most likely to leak; scoped this way, leaking it costs a spurious
schedule entry, not the escrow. The moderator key can stop something before it reaches the board
but cannot cut short a rental someone is already paying for and watching — that is a Safe
decision, taken deliberately and slowly.

Funds and configuration stay with the Safe, always.

### W14. `maxStartsAt` on the quote

The quote carries a `maxStartsAt`, and `rent` reverts if the computed `startsAt` exceeds it.

Without it, a buyer signs for a slot that starts in twenty minutes and — if the queue grows
between the quote and the transaction landing — pays the same money for one that starts in
nineteen hours. The wait is the product. A buyer must not be able to lose it to a race, any more
than they can be re-priced by one (W4).

### W15. Cancelling before the start costs 10%

`cancel` refunds 90% to `claimable` and sends 10% to `platformBalance`.

A free cancel makes the queue a free option: buy up the next six hours, cancel the moment a rival
tries to book, and the slot is yours whenever you want it at no cost. The fee is what makes
queue-stuffing cost something. It is charged only on a rental that has **not started** — a rental
under way cannot be cancelled by its renter at all.

Fuzz asserts `refund + fee == paid` exactly, so the fee cannot create or destroy dust.

### W16. A fiat rental that cannot be scheduled is refunded

`registerFiat` can revert legitimately: the cap was reached, or the slot was taken between the
Stripe session starting and the payment clearing. When it does, the webhook **refunds the Stripe
payment and records the reason** on the purchase.

This is the one place the existing, so-far-unused Stripe refund path earns its keep — and the
existing `WebhookOutcome` already has a `refunded` variant for exactly this shape, because the
queue cap could already do it. The registration is retried a bounded number of times first
(transient RPC failure is not a capacity failure), and only a genuine revert triggers the refund.

### W19. x402 signs `transferWithAuthorization`, and we want `receiveWithAuthorization` — **OPEN**

Checked against the spec rather than assumed, and the two do not line up.

The x402 exact-EVM scheme has the client sign an EIP-712 **`TransferWithAuthorization`** struct
with `to` set to `payTo`, and the facilitator settles by calling `transferWithAuthorization`
directly on the token. The spec is explicit that `to` is "the intended payment recipient — not a
contract intermediary", precisely so a facilitator cannot redirect funds.

Our design wants the opposite shape, for a good reason. If `payTo` is `SlotMarket` and the
authorization is a _transfer_, **anyone may submit it to USDC on its own**: the money lands in the
contract, no rental is created, the nonce is spent, and the funds are stranded. Paying and
scheduling have to be one atomic act, which is exactly what `receiveWithAuthorization` gives —
only `to` may call it, so the pull and the rental happen in the same call or not at all.

So the instinct behind the phase 1 change is right, and it is the stock x402 flow that is unsafe
_for this particular use_, because x402 assumes `payTo` is a recipient rather than a contract that
must do something atomically with the money.

Three ways out, and W17 means the choice cannot be deferred — an immutable contract gets one shot
at having both:

|                                                                                                                                               | Interoperability                                               | Safety                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **(a) Spec-compliant only** — `transferWithAuthorization`, contract submits it to USDC itself then creates the rental in the same transaction | Any stock x402 client works                                    | A third party can front-run by submitting the auth to USDC directly; needs an orphan-recovery path for stranded funds |
| **(b) Receive-only** — `receiveWithAuthorization`, as the phase 1 change asks                                                                 | Stock clients cannot pay; we publish a small client of our own | Atomic by construction. No stranding, no front-run, no recovery path to get wrong                                     |
| **(c) Both** — `rentWithAuthorization` (receive) and `rentWithTransferAuthorization` (transfer, with recovery)                                | Full                                                           | Two payment paths to test and audit, and the weaker one still exists                                                  |

**Recommendation: (c), decided now.** The extra surface is real, but it is the only option that does
not have to be regretted later, and the agent audience is the whole point of phase 5.5. If the
answer is (b), the phase 5.5 test plan changes — a stock SDK will not be able to pay, so the e2e
agent client becomes ours.

This is the one thing in phase 5.5 that needs an answer before phase 1 is written.

### W17. The contract is immutable

No proxy, no upgrade path, no admin-swappable implementation. An upgradeable escrow is an escrow
whose owner can rewrite the rules over funds other people put in, and the whole argument for
putting the money onchain is that they do not have to trust that.

Migration is therefore a redeploy, and phase 6 documents it as a procedure rather than
discovering it under pressure:

1. Deploy v2; grant it no authority over v1.
2. `setPaused(true)` on v1 — new rentals stop, `claim` keeps working (pausing must never block a
   refund).
3. Let v1's remaining rentals run out and settle. The longest possible tail is 24 hours plus the
   queue cap, so 48 hours bounds it.
4. Point the app and the indexer at v2.
5. `withdraw` the v1 platform balance once every rental has settled.

Slot scheduling state (`freeAt`) does not migrate: v2 starts empty, which is correct, because v1
is still serving the rentals that produced it.

### W18. Mainnet is gated on legal advice and an external audit

Testnet until both are done. Not one or the other — the contract holds other people's money, and
the product takes payment to promote financial products in a jurisdiction that regulates exactly
that.

---

## Phase 0 — foundations

**Blocked on the network policy.** The container's proxy currently denies every host this needs:

- `foundry.paradigm.xyz` and the GitHub release host — the `forge` binary itself
- `sepolia.base.org`, `*.g.alchemy.com` — RPC
- `api-sepolia.basescan.org` — verification and the trust badges

Nothing onchain can be built until these are allowlisted. Writing `SlotMarket.sol` without being
able to run `forge test` would mean shipping untested escrow code, which is worse than shipping
none.

**The Solidity libraries do not need an allowlist.** `@openzeppelin/contracts` (5.6.1),
`forge-std` (1.1.2) and `solc` (0.8.37) are all on npm, which already works here, so they come in
as dev dependencies and `remappings.txt` points at `node_modules/` rather than at `lib/`. That
drops `github.com/foundry-rs/*` off the list, pins the libraries in the lockfile alongside
everything else, and puts them in range of the same dependency tooling as the rest of the repo.

**Create**

- `contracts/` as a Foundry root: `foundry.toml`, `remappings.txt`, `contracts/.gitignore` — no
  `lib/` and no submodules; libraries resolve through `node_modules/`
- `.github/workflows/contracts.yml` — `forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage`

**Change**

- `README.md` — a contracts section
- `.env.example` — `BASE_SEPOLIA_RPC_URL`, `SLOT_MARKET_ADDRESS`, `USDC_ADDRESS`,
  `QUOTE_SIGNER_ADDRESS`, `ALCHEMY_API_KEY`, `BASESCAN_API_KEY`, **all commented out**

That last point is not housekeeping. #31's review found that an uncommented fixture in
`.env.example` is what a fresh deployment actually runs with, because the setup step is
`cp .env.example .env.local`. The same rule applies to every variable added here.

**Risks**

No private key ever enters the repository or `.env.example`. Deployment uses a `cast wallet`
keystore or the Safe; CI never holds a key and never deploys.

---

## Phase 1 — `SlotMarket.sol` and its tests

**Create**

- `contracts/src/SlotMarket.sol`, `contracts/src/ISlotMarket.sol`
- `contracts/test/{Rent,Settle,Kill,Cancel,Claim,Admin,Quote}.t.sol`
- `contracts/test/fuzz/{Accounting,Schedule}.t.sol`
- `contracts/test/invariant/SlotMarketInvariants.t.sol`
- `contracts/test/mocks/MockUSDC.sol`
- `contracts/script/Deploy.s.sol`

### Interface

```solidity
enum Status { Active, Settled, Killed, Cancelled }

struct Rental {
    address renter;
    uint8   slot;          // 1..3
    uint16  durationH;     // 1 | 3 | 6 | 12 | 24
    uint64  startsAt;
    uint64  endsAt;
    uint128 paid;          // USDC, 6 decimals
    uint128 rateHr;
    bytes32 contentHash;
    Status  status;
}

struct Quote {             // EIP-712, signed by QUOTE_SIGNER
    address renter;
    uint8   slot;
    uint16  durationH;
    uint128 rateHr;
    uint64  maxStartsAt;   // W14 — revert if the queue grew past this
    bytes32 contentHash;
    uint256 nonce;
    uint64  expiry;
}

function rent(Quote calldata q, bytes calldata sig) external returns (uint256 id);
function rentWithPermit(Quote calldata q, bytes calldata sig, Permit calldata p)
    external returns (uint256 id);

// REGISTRAR_ROLE, zero payment. See W11, W13.
function registerFiat(address renter, uint8 slot, uint16 durationH, bytes32 contentHash)
    external returns (uint256 id);

// Agent booking over x402 (phase 5.5). authNonce == keccak256(abi.encode(q)) binds one
// authorization to exactly one quote. Which of these two exists is W19.
function rentWithAuthorization(
    Quote calldata q, bytes calldata quoteSig,
    uint256 validAfter, uint256 validBefore, bytes32 authNonce,
    uint8 v, bytes32 r, bytes32 s
) external returns (uint256 id);                         // USDC.receiveWithAuthorization

function rentWithTransferAuthorization(
    Quote calldata q, bytes calldata quoteSig,
    uint256 validAfter, uint256 validBefore, bytes32 authNonce,
    uint8 v, bytes32 r, bytes32 s
) external returns (uint256 id);                         // USDC.transferWithAuthorization

function settle(uint256 id) external;                    // permissionless, after endsAt
function settleMany(uint256[] calldata ids) external;    // length-capped
function cancel(uint256 id) external;                    // renter, before startsAt, 10% fee (W15)
function kill(uint256 id, string calldata reason) external;     // MODERATOR_ROLE, before startsAt
function killLive(uint256 id, string calldata reason) external; // DEFAULT_ADMIN_ROLE (Safe)
function claim() external;                               // pull refunds — never pausable
function withdraw(address to, uint128 amount) external;  // DEFAULT_ADMIN_ROLE

function setQuoteSigner(address next) external;           // DEFAULT_ADMIN_ROLE
function setMinRate(uint8 slot, uint128 rateHr) external; // DEFAULT_ADMIN_ROLE
function setPaused(bool paused) external;                 // DEFAULT_ADMIN_ROLE

function freeAt(uint8 slot) external view returns (uint64);
function rentalOf(uint256 id) external view returns (Rental memory);
function earnedOf(uint256 id, uint64 at) external view returns (uint128);
```

Every state change emits: `Rented`, `FiatRegistered`, `Settled`, `Killed`, `Cancelled`,
`Claimed`, `Withdrawn`, `QuoteSignerChanged`, `MinRateChanged`, `PausedSet`. Role changes emit
`AccessControl`'s own `RoleGranted` / `RoleRevoked`.

W13 splits kill in two. `kill` is for a rental that has not started — a moderator hot key may call
it, and it refunds in full because nothing was delivered. `killLive` cuts short a rental already
on the board, refunds the unused portion, and is Safe-only: taking away something a buyer is
watching in real time should cost a multisig round trip.

### Accounting

```
paid   = rateHr * durationH
earned = paid * clamp(now - startsAt, 0, duration) / duration
refund = paid - earned
```

Settlement is O(1) per rental: earned moves to `platformBalance`, unearned moves to
`claimable[renter]`. **No balance is ever computed by summing over rentals** — that is what
would force an unbounded loop, and it is why settlement is per-rental and permissionless. The
hourly job settles what is due in capped batches; anyone else may too.

`cancel` is deliberately limited to a rental that has **not yet started**, and costs 10% (W15). A
renter cancelling a live rental would be a self-service refund of time the board has already given
them, and would make the board unstable for everyone downstream. A _free_ cancel before the start
would make the queue a free option — buy the next six hours, cancel the moment a rival tries to
book — so the fee is what gives queue-stuffing a price.

### What the contract enforces rather than trusts

The server proposes; the contract checks. A lying or compromised server cannot get past:

- a valid EIP-712 signature from the current signer, with `chainId` bound in the domain
- an unexpired `expiry` and an unspent `nonce` — no replay
- `rateHr >= minRate[slot]` — the floor from W4
- `durationH` is one of the five snap points
- `startsAt >= freeAt[slot]` — non-overlap, enforced onchain even though scheduling is offchain
- `startsAt <= q.maxStartsAt` — the buyer's own ceiling on the wait (W14)
- on the authorization entry points, `authNonce == keccak256(abi.encode(q))` — a payment
  authorization is bound to exactly one quote, so it cannot be replayed against a cheaper or
  later one, and `value` must equal `rateHr * durationH`
- `freeAt - now <= 24h` — the existing wait cap
- not paused

### Libraries and discipline

OpenZeppelin `AccessControl`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, `EIP712`, `ECDSA`,
`Nonces`, from npm (see phase 0). Checks-effects-interactions throughout; `claim()` zeroes the
balance before transferring. The contract is immutable — no proxy, no initialiser (W17).

### Tests

Unit tests per function, including one per role boundary: every privileged function called by
every wrong role, and required to revert. Fuzz over `(rateHr, durationH, elapsed)` asserting
`earned + refund == paid` exactly — no dust created or destroyed — that `earned` is monotonic in
time, and that `refund + fee == paid` on a cancel. Invariant tests asserting
`USDC.balanceOf(market) >= platformBalance + Σ claimable + Σ paid(unsettled)`, that no two rentals
on a slot ever overlap, and that `claim` still succeeds while paused.

### Risks

| Risk                             | Mitigation                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reentrancy                       | CEI, `ReentrancyGuard`, and pull-based refunds — there is no push to an arbitrary address                                                          |
| Signature replay                 | Nonce, expiry, and `chainId` in the EIP-712 domain                                                                                                 |
| Hot signer key                   | `minRate[slot]` floor bounds the damage; `setQuoteSigner` rotates                                                                                  |
| USDC 6-decimal rounding          | Fuzz asserts the exact-sum invariant, so rounding cannot leak value                                                                                |
| USDC blocklist                   | Pull model leaves funds claimable rather than bricking a settlement                                                                                |
| `pause` as griefing              | Pausing must never block `claim`                                                                                                                   |
| Admin kill centralisation        | Cutting short a _live_ rental is Safe-only; a moderator key can only stop one that has not started. Both event-logged, mirroring #17's audit trail |
| Registrar key compromise         | Scoped to `registerFiat`; cannot move funds or change config (W13)                                                                                 |
| Buyer loses slot time to a race  | `maxStartsAt` reverts rather than delivering a worse product at the same price (W14)                                                               |
| Fee-on-transfer / rebasing token | Not applicable to USDC, but the received amount is asserted anyway                                                                                 |

---

## Phase 2 — wallet connect and the pay flow

**Add** `wagmi`, `viem`, and a connect kit (RainbowKit or ConnectKit).

**Create**

- `src/lib/chain/{config,client,contract}.ts`
- `src/lib/quote/sign.ts` — EIP-712 signing, `server-only`
- `src/app/api/quote/route.ts` — **refuses to sign for an unapproved advertiser or unapproved
  content** (W6); this gate ships here, the UI for it ships in phase 5
- `src/lib/chain/register-fiat.ts` — the registrar call, its bounded retry, and the refund (W16)
- `src/components/wallet/{provider,connect-button}.tsx`
- `src/components/checkout/crypto-flow.tsx`
- `src/lib/chain/sync.ts` — the log poller

**Change**

- `src/app/checkout/page.tsx` — fiat or crypto
- `src/app/layout.tsx` — wallet provider
- `src/lib/config/{server,client}.ts`
- `src/app/api/cron/hourly/route.ts` — poll logs, settle due rentals, retry pending fiat registrations
- `src/lib/payments/webhook.ts` — register onchain, and refund the Stripe payment when
  registration genuinely cannot be scheduled (W16). The existing `WebhookOutcome.refunded`
  variant already has the right shape

**Data model**

```prisma
enum PaymentMethod { stripe, usdc_base }

// Purchase gains:
//   paymentMethod PaymentMethod
//   chainId Int?  rentalId BigInt?  txHash String?
//   renterAddress String?  contentHash String?
//   @@unique([chainId, rentalId])

model ChainCursor { chainId Int @id  lastBlock BigInt  updatedAt DateTime }

// A fiat purchase awaiting its onchain schedule entry. `outcome` records why a
// registration was abandoned, which is what the refund reason is written from (W16).
model FiatRegistration {
  purchaseId String @id  status  attempts Int
  lastError String?  outcome String?  refundedAt DateTime?
}

model Advertiser { wallet String @id  status  approvedBy String?  approvedAt DateTime? }
```

`Advertiser` lands here rather than in phase 5 because W6 makes approval a precondition of
signing a quote. Phase 5 adds the queue that operates on it.

`@@unique([chainId, rentalId])` is the crypto equivalent of `stripeSessionId`: it makes log
replay idempotent **by constraint** rather than by checking first, which is the same reasoning
the Stripe webhook already uses and the same reason it cannot race.

**Risks**

The quote signer becomes a production secret — environment only, never `.env.example`, and named
in `scripts/check-client-bundle.mjs` so a leak into the browser bundle fails CI. Reorgs mean a
confirmation threshold before a rental is shown; Base reorgs are shallow but real. An RPC outage
must never block a board render — the board reads the database mirror, exactly as it reads cached
avatars rather than fetching them. `approve` is a second transaction, so offer `rentWithPermit`.
Wallet libraries are heavy: lazy-load them, and keep the board itself a server component.

---

## Phase 3 — per-slot stats

**Create** `src/lib/stats/{record,read}.ts`, `src/app/api/stats/[purchaseId]/route.ts`,
`src/components/board/slot-stats.tsx`.
**Change** `src/components/board/{slot-one,slot-row}.tsx`. Clicks already exist
(`src/lib/embed/clicks.ts`, `purchase.clicks`).

**Data model** `SlotImpression { purchaseId, hourBucket, count }` and
`SlotWalletConnect { purchaseId, hourBucket, count }` — hourly buckets, bot-filtered through the
existing `looksLikeABot`, visitor-hashed the way `Visit` already is.

**Risk — the one that matters in this phase.** The never-fabricate rule applies with full force
to numbers a buyer is being sold on. An impression is defined as _a board render that included
this slot, deduped per visitor-window_, and the UI says that rather than implying reach. A wallet
connect is only attributable when it happens while that slot is live, so it is defined narrowly
and labelled. No estimates, no rounded-up uniques, no "reach".

---

## Phase 4 — announcements

**Create** `src/lib/social/{telegram,format,announce}.ts`, and a `SocialPost` model whose unique
key is `(purchaseId, event)` so a retried log poll cannot double-post.
**Change** the hourly job and the `Rented` log handler.

**Risks.** Announce only **after** moderation clears, never on payment — otherwise the bot
advertises a scam before a human has looked at it. Double-posting is prevented by a constraint,
not a check. Platform rate limits reuse the existing GCRA limiter from #18. Credentials live in
the environment.

---

## Phase 5 — trust badges and the approval queue

The gate itself shipped in phase 2 (W6). This phase gives it a surface and adds the badges.

**Create** `src/lib/trust/{basescan,lp-lock,store}.ts`, `src/app/admin/approvals/page.tsx`,
`src/app/api/admin/approve/route.ts`, `src/components/board/trust-badges.tsx`.
**Change** the existing `/admin` console and the `AdminAction` audit trail, which already has the
right shape from #17.

**Data model**

```prisma
// Advertiser arrives in phase 2 — the quote gate needs it. Phase 5 adds:
model SlotContent { purchaseId String @id  name  ticker  tokenAddress  chain
                    logo Bytes  ctaType  ctaUrl  approvedAt DateTime? }
model TrustBadge  { purchaseId String @id  contractVerified Boolean  lpLocked Boolean
                    lpLockSource String?  auditUrl String?  checkedAt DateTime }
```

The logo is stored and re-encoded like an `Avatar` — self-hosted, metadata stripped, so the board
still makes no third-party request. It is also what makes `contentHash` mean anything.

**Risks.** A badge is a claim _TopNow_ is making. "LP locked" is only as good as the locker
contract checked, so the UI renders **what was checked and when**, never a bare green tick. A
Basescan rate-limits and changes its API. Approval is now a gate on revenue: if the queue is not
staffed, nobody new can buy — the right failure direction, but it has to be visible, so the
console shows how long the oldest pending submission has waited.

**Regulatory scaffolding lands here** (W9): the per-slot disclaimer, a submission-time check for
banned categories — securities-like offerings, yield or APY promises, guaranteed returns —
surfaced in the approval queue rather than auto-rejected, and an admin-configurable geo-block
list. This is scaffolding for legal advice, not a substitute for it.

---

## Phase 5.5 — x402 agent booking

An AI agent discovers the price and books a slot over plain HTTP, paying USDC on Base, with no
checkout UI anywhere in the loop. Depends on phases 1, 2 and 5 — approval gates it (W6), so it
cannot ship before the thing that approves.

### Field names are taken from the spec, not from memory

Checked 2026-09-25 against
[the v2 specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md),
[the HTTP transport](https://github.com/coinbase/x402/blob/main/specs/transports-v1/http.md) and
[the exact-EVM scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).
Four things differ from what a reasonable person would guess, and three of them would have been
wrong:

| Guess                      | Actual                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `maxAmountRequired`        | **`amount`** in v2 (`maxAmountRequired` was v1)                                                                          |
| `network: "base-sepolia"`  | **CAIP-2**: `eip155:84532`                                                                                               |
| `resource` is a URL string | an **object**: `url`, `description`, `mimeType`                                                                          |
| put our quote in `extra`   | `extra` is **reserved by the exact scheme** for `name`, `version`, `assetTransferMethod` — ours goes in **`extensions`** |

`x402Version: 2` is required in every message. Headers are `X-PAYMENT` and `X-PAYMENT-RESPONSE`,
each carrying base64-encoded JSON.

### Flow

1. **`GET /api/x402/slots`** — free. Slots, `freeAt`, and the current ask. The price comes from the
   same curve the board uses; there is no separate agent price, and nothing here is fabricated.

2. **`POST /api/x402/rent`** `{slot, durationH, contentId}` with no payment → **402** carrying
   `accepts[0]` with `scheme: "exact"`, `network: "eip155:84532"`, `amount`, `asset` (USDC),
   `payTo` (the `SlotMarket` address), `maxTimeoutSeconds`, and
   `extra: { name, version, assetTransferMethod: "eip3009" }` — the token's own EIP-712 domain,
   which the spec requires. The signed `Quote` and `quoteSig` ride in **`extensions`**, namespaced,
   because `extra` is not ours to put things in. The quote's `expiry` is set at or beyond
   `maxTimeoutSeconds`, so an agent that uses the whole window still has a valid quote.

3. The agent signs an **EIP-3009** authorization and retries with `X-PAYMENT`.

4. The server verifies the signature, the amount and the binding, then submits the rental. **TopNow
   is its own facilitator and pays the gas.** It waits for the confirmation threshold from phase 2,
   then answers **200** with `rentalId`, `startsAt`, `endsAt` and `txHash`, and a
   `X-PAYMENT-RESPONSE` header carrying the base64 `SettlementResponse`.

Which authorization the agent signs, and therefore whether a stock x402 client can pay at all, is
**W19** — open, and blocking phase 1.

### Gating

The payer wallet must be an approved `Advertiser`, and `contentId` must resolve to approved content
whose hash equals the `contentHash` in the quote. Otherwise **403**, with a link to human
onboarding. **Agents never bypass moderation** — the quote is not signed, so there is nothing to
pay with, which is the same gate the web flow uses rather than a second one written for agents.

### Files

**Create** `src/lib/x402/{requirements,verify,settle,version}.ts`,
`src/app/api/x402/slots/route.ts`, `src/app/api/x402/rent/route.ts`,
`contracts/test/RentWithAuthorization.t.sol`, `e2e/x402-agent.spec.ts`.
**Change** `src/lib/config/server.ts` (relayer key, confirmation threshold),
`src/lib/limit/limiter.ts` (an `x402` bucket).

### Data

`Purchase.paymentMethod` gains `usdc_base_x402`.

```prisma
model X402Payment {
  authNonce  String @unique   // keccak256(abi.encode(quote)) — one auth, one quote
  purchaseId String?
  payer      String
  status     String
  createdAt  DateTime @default(now())
}
```

`@@unique` on `authNonce` is what makes a replayed `X-PAYMENT` idempotent **by constraint** rather
than by checking first — the same reasoning as `stripeSessionId` and `(chainId, rentalId)`, and the
same reason it cannot race.

### Risks

**Gas griefing.** The relayer pays, so a rejected payment still costs us. Rate-limit per wallet and
per IP through the existing GCRA limiter (#18), and verify the signature, the binding and the
payer's balance _before_ submitting anything.

**Hot relayer key.** It holds no roles (W13) — `rentWithAuthorization` is permissionless because
the authority comes from the renter's own signature, not from the submitter. Keep it minimally
funded and alert on a low balance. A stolen relayer key buys gas, nothing else.

**Quote and authorization disagreeing.** Bound in the contract by
`authNonce == keccak256(abi.encode(q))`, so an authorization cannot be replayed against a different
quote.

**Spec drift.** x402 is young and has already moved once — v1 to v2 renamed fields this plan would
otherwise have got wrong, and a second repository (`x402-foundation/x402`) now mirrors it. Pin the
version in `src/lib/x402/version.ts`, keep every spec-shaped type inside `src/lib/x402/`, and let
nothing else in the app know the protocol exists.

**Regulatory.** Identical to the web flow: disclaimer, banned-category check, geo-block (W9). An
agent is not a different legal category of buyer.

### Tests

Contract: unit and fuzz for the authorization entry point, including a replayed nonce, a mismatched
quote, an expired `validBefore` and a wrong `value`. End to end: a scripted agent client driving
the full 402 → sign → retry → 200 round trip against Base Sepolia. Whether that client is the
official SDK or ours is W19.

### Later

A free content-submission endpoint for agents (still human-approved), and listing in x402
discovery.

---

## Phase 6 — post-MVP

Outbidding on the live slot (≥10%, 15-minute protection, ousted tenant refunded pro-rata to
`claimable`, queue survives and shifts) — this is where W12 gets solved properly. Then advance
reservations for launch day, an embeddable leaderboard widget (iframe plus `postMessage` for
height), takeover animations, and a hall of fame.

Viewer rewards are **non-monetary points and badges only** (W9). Points for check-ins and clicks,
rate-limited and sybil-resistant through the existing visitor hashing; no payouts and no
prediction market.

**Risks.** Outbidding is the hardest contract change in the whole plan: griefing by repeated 10%
bumps, MEV on the takeover transaction, and refund accounting mid-rental. Points invite farming,
which is why they stay non-monetary.

---

## Cross-cutting

**Testnet only** until legal advice and an external audit are both done (W18). Every phase ends green on: `forge test`, `npm test`,
`npm run test:e2e`, lint, format, typecheck, the price-literal check, the client-bundle scan, and
gitleaks. One feature per branch, one PR, a summary, then a stop for approval before the next.

Contract discipline, restated because it is the part that cannot be patched after deployment:
checks-effects-interactions; OpenZeppelin where it is the obvious tool; **no unbounded loops**;
an event for every state change.

---

## Before phase 1 can start

W11 is confirmed and this branch is cut from
[#31](https://github.com/meemimos/topnow.live/pull/31). One thing remains:

**Answer W19** — whether the contract accepts a receive authorization, a transfer authorization,
or both. It changes the phase 1 interface, and W17 means there is no second chance at it.

**Allowlist `foundry.paradigm.xyz` and the GitHub release host.** Without `forge`, phase 1 is
untestable escrow code, and untested escrow code is not worth writing. The RPC and Basescan hosts
are needed from phase 2 and phase 5 respectively, so they can follow.

The Solidity libraries no longer need an allowlist: they come from npm.
