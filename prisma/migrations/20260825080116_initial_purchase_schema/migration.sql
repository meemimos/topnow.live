-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('github', 'youtube', 'instagram', 'tiktok', 'reddit', 'web');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('queued', 'live', 'ended', 'killed');

-- CreateTable
CREATE TABLE "purchase" (
    "id" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "handle" VARCHAR(64) NOT NULL,
    "platform" "Platform" NOT NULL,
    "displayName" VARCHAR(24),
    "targetUrl" VARCHAR(2048) NOT NULL,
    "tagline" VARCHAR(60) NOT NULL,
    "durationH" INTEGER NOT NULL,
    "priceHrCents" INTEGER NOT NULL,
    "totalPaidCents" INTEGER NOT NULL,
    "boughtAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "status" "PurchaseStatus" NOT NULL DEFAULT 'queued',
    "killedAt" TIMESTAMPTZ(3),
    "killedReason" VARCHAR(500),
    "stripeSessionId" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ask_sample" (
    "id" SERIAL NOT NULL,
    "slot" INTEGER NOT NULL,
    "hour" TIMESTAMPTZ(3) NOT NULL,
    "askHrCents" INTEGER NOT NULL,
    "baseHrCents" INTEGER NOT NULL,
    "queuedHours" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ask_sample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_stripeSessionId_key" ON "purchase"("stripeSessionId");

-- CreateIndex
CREATE INDEX "purchase_slot_status_boughtAt_idx" ON "purchase"("slot", "status", "boughtAt");

-- CreateIndex
CREATE INDEX "purchase_status_boughtAt_idx" ON "purchase"("status", "boughtAt");

-- CreateIndex
CREATE INDEX "purchase_status_endsAt_idx" ON "purchase"("status", "endsAt");

-- CreateIndex
CREATE INDEX "ask_sample_slot_hour_idx" ON "ask_sample"("slot", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "ask_sample_slot_hour_key" ON "ask_sample"("slot", "hour");

-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express.
--
-- These are not belt-and-braces. #1 solves concurrent promotion with database
-- guarantees rather than application locks, and this is where those guarantees
-- live. Nothing below may be relaxed into an application-level check.
-- ---------------------------------------------------------------------------

-- THE constraint. At most one live rental per slot, at any instant, no matter
-- how many transactions race. Two concurrent promotions on one slot cannot both
-- win: the loser gets a unique violation and retries, which is exactly the
-- behaviour #1 needs.
CREATE UNIQUE INDEX "purchase_one_live_per_slot"
  ON "purchase" ("slot")
  WHERE "status" = 'live';

-- Three slots. Not two, not four.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_slot_range" CHECK ("slot" BETWEEN 1 AND 3);

-- Durations are snap points, never an arbitrary number of hours.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_duration_snap_point"
  CHECK ("durationH" IN (1, 3, 6, 12, 24));

-- Money is integer cents and is never negative. A free rental would be a bug in
-- the pricing engine (#2), not a valid state.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_price_positive" CHECK ("priceHrCents" > 0);
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_total_positive" CHECK ("totalPaidCents" > 0);

-- The total must be the locked hourly rate times the hours. This is what stops
-- a total and its derivation disagreeing on the receipt (#9).
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_total_matches_rate"
  CHECK ("totalPaidCents" = "priceHrCents" * "durationH");

-- A queued row has not started. A live or ended row has. A killed row may be
-- either, because a listing can be killed from the queue or off the board (#17).
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_timestamps_match_status" CHECK (
    CASE "status"
      WHEN 'queued' THEN "startsAt" IS NULL AND "endsAt" IS NULL
      WHEN 'live'   THEN "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL
      WHEN 'ended'  THEN "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL
      WHEN 'killed' THEN ("startsAt" IS NULL) = ("endsAt" IS NULL)
    END
  );

-- endsAt is startsAt plus the booked duration. Enforced, not assumed — the
-- countdown (#3) and the depletion bar (#7) both derive from this window, and a
-- row where it does not hold would render a rental that outlives what was paid
-- for.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_ends_at_derived" CHECK (
    "startsAt" IS NULL
    OR "endsAt" = "startsAt" + make_interval(hours => "durationH")
  );

-- A rental cannot start before it was bought.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_starts_after_bought"
  CHECK ("startsAt" IS NULL OR "startsAt" >= "boughtAt");

-- killedAt is set exactly when the row is killed.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_killed_at_matches_status"
  CHECK (("status" = 'killed') = ("killedAt" IS NOT NULL));

-- Websites have no handle to show, so they carry a display name. Every other
-- platform shows the handle and must not carry one.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_display_name_for_web_only" CHECK (
    ("platform" = 'web' AND "displayName" IS NOT NULL AND length("displayName") > 0)
    OR ("platform" <> 'web' AND "displayName" IS NULL)
  );

-- Non-website listings always have a handle.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_handle_present"
  CHECK ("platform" = 'web' OR length("handle") > 0);

-- Only https targets are ever stored. The scheme allow-list is also enforced at
-- submission (#8) and at avatar resolution (#19); this is the backstop.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_target_url_https" CHECK ("targetUrl" LIKE 'https://%');

-- ---------------------------------------------------------------------------
-- ask_sample
-- ---------------------------------------------------------------------------

ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_slot_range" CHECK ("slot" BETWEEN 1 AND 3);

ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_ask_positive" CHECK ("askHrCents" > 0);

ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_base_positive" CHECK ("baseHrCents" > 0);

-- Surge never prices below base and is capped at 2x (decision D2).
ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_within_surge_band"
  CHECK ("askHrCents" >= "baseHrCents" AND "askHrCents" <= "baseHrCents" * 2);

ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_queued_hours_non_negative" CHECK ("queuedHours" >= 0);

-- Samples are hourly. A sample stamped mid-hour would produce two candles for
-- one hour and break the unique constraint's meaning.
ALTER TABLE "ask_sample"
  ADD CONSTRAINT "ask_sample_hour_truncated"
  CHECK ("hour" = date_trunc('hour', "hour"));
