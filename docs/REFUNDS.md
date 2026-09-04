# Refunds

**Decision D4, resolved 2026-09-04 by @meemimos. Implemented in #17.**

## The policy

**A listing taken down by TopNow is not refunded.** The hours remaining on it are
forfeited — no pro-rata credit, no partial refund, no store credit.

This applies only to a takedown. Nothing else in the product removes a paid
listing: a rental that runs its hours has had what it paid for, and a listing
still in the queue when a slot is killed keeps its place.

## Why it is written down

#17 makes this a launch blocker, and the reason is that it is the first question
a taken-down buyer asks. A policy invented at that moment is a policy invented
under pressure, by whoever happens to answer, and it will not match the one
invented the next time.

## Why "none" rather than pro-rata

A takedown means the listing broke the rules — an account the buyer did not own,
a link that harmed whoever followed it, copy written to abuse somebody. Refunding
it makes the attempt free: the worst case for a buyer who lists somebody else's
handle becomes "I get my money back", which is not a deterrent, it is a trial
run.

The cost of the alternative is real and it is accepted: an honest listing removed
by a mistaken takedown loses money as well as its slot. What that buys is that
the appeal path is a conversation with a person about a decision, rather than an
automatic refund that makes the decision cost nothing to get wrong in the other
direction.

## What it requires of the product

The forfeit is only defensible if it is stated before anyone pays, so it is
stated twice:

- **`/terms`** — "Takedowns, and the refund", in full.
- **The checkout receipt** — above the pay button, next to the total.

Both are in place. If either is removed, this policy stops being defensible with
it.

## What it means in code

- `killPurchase` issues no Stripe refund and calls nothing in `@/lib/payments`.
- There is no partial-refund path, and nothing reconciles the ledger against
  Stripe refund objects, because there are none to reconcile.
- The killed row keeps `totalPaidCents` as paid. The sale happened; the chart's
  history is a record of sales, and it is not rewritten.

## What is deliberately out of scope

A refund on a **support** basis — a duplicate charge, a payment taken for a slot
that never went live, a genuine error by TopNow — is a different thing from a
takedown and is not covered here. It is handled through Stripe directly, by a
person, and it is not a product feature.
