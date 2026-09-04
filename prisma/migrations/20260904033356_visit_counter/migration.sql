-- CreateTable
CREATE TABLE "visit" (
    "id" SERIAL NOT NULL,
    "visitorHash" VARCHAR(64) NOT NULL,
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "visit_lastSeenAt_idx" ON "visit"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "visit_visitorHash_bucket_key" ON "visit"("visitorHash", "bucket");

-- The hash is a fixed-width hex digest. Anything else means something wrote a
-- raw identifier into a column that must never hold one.
ALTER TABLE "visit"
  ADD CONSTRAINT "visit_hash_is_sha256_hex" CHECK ("visitorHash" ~ '^[0-9a-f]{64}$');

-- A visit cannot have been last seen before it was first seen.
ALTER TABLE "visit"
  ADD CONSTRAINT "visit_last_seen_after_first" CHECK ("lastSeenAt" >= "firstSeenAt");
