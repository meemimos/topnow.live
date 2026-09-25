-- CreateTable
CREATE TABLE "rate_limit" (
    "key" VARCHAR(128) NOT NULL,
    "tat" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_expiresAt_idx" ON "rate_limit"("expiresAt");

-- A bucket with no key is not a bucket. Empty string is a real value and would
-- collapse every unidentifiable caller into one shared budget.
ALTER TABLE "rate_limit"
  ADD CONSTRAINT "rate_limit_key_present" CHECK (length("key") > 0);

-- The pruner deletes rows whose "expiresAt" has passed, on the argument that a
-- refilled bucket permits what no row permits. That argument only holds while
-- expiry is genuinely after the bucket is paid up to; if it were not, pruning
-- would hand a rate-limited caller a fresh budget. Enforced here rather than
-- trusted to the caller, because the failure is silent.
ALTER TABLE "rate_limit"
  ADD CONSTRAINT "rate_limit_expires_after_tat" CHECK ("expiresAt" > "tat");
