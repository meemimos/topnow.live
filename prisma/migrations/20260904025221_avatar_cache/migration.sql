-- CreateEnum
CREATE TYPE "AvatarStatus" AS ENUM ('ok', 'unavailable', 'failed');

-- CreateTable
CREATE TABLE "avatar" (
    "id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "handle" VARCHAR(64) NOT NULL,
    "status" "AvatarStatus" NOT NULL,
    "contentType" VARCHAR(64),
    "large" BYTEA,
    "small" BYTEA,
    "sourceUrl" VARCHAR(2048),
    "failureReason" VARCHAR(500),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "avatar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "avatar_status_resolvedAt_idx" ON "avatar"("status", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "avatar_platform_handle_key" ON "avatar"("platform", "handle");

-- Correctness lives in the schema, not only in the code that writes to it.
-- Every constraint below is something the resolver already intends; expressing
-- it here means a future writer that forgets cannot leave the table lying.

-- Bytes exist exactly when the row says they do. Without this, a row could
-- claim `ok` with nothing to serve, and /api/avatar would 500 on a read.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_bytes_match_status" CHECK (
    ("status" = 'ok') = ("large" IS NOT NULL AND "small" IS NOT NULL AND "contentType" IS NOT NULL)
  );

-- A row that is not ok has no bytes at all. Keeping stale bytes behind a failed
-- status would mean the board could serve an avatar the resolver has since
-- decided is wrong.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_no_bytes_unless_ok" CHECK (
    "status" = 'ok' OR ("large" IS NULL AND "small" IS NULL)
  );

-- Every non-ok row explains itself. A blank failure is a debugging dead end six
-- months from now.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_reason_when_not_ok" CHECK (
    "status" = 'ok' OR ("failureReason" IS NOT NULL AND length("failureReason") > 0)
  );

-- The lookup key is case-folded. Enforced here rather than trusted from the
-- application, because a mixed-case duplicate would defeat the unique index and
-- silently double every resolution for that account.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_handle_lowercase" CHECK ("handle" = lower("handle"));

ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_handle_present" CHECK (length("handle") > 0);

ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_attempts_non_negative" CHECK ("attempts" >= 0);

-- Only ever our own re-encode. A row claiming to hold anything else means
-- something bypassed the encoder.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_content_type_is_webp" CHECK (
    "contentType" IS NULL OR "contentType" = 'image/webp'
  );

-- Same rule as purchase.targetUrl: a recorded source is absolute and https.
ALTER TABLE "avatar"
  ADD CONSTRAINT "avatar_source_url_https" CHECK (
    "sourceUrl" IS NULL OR "sourceUrl" LIKE 'https://%'
  );
