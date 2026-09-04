-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('impersonation', 'malicious_link', 'abusive_copy', 'other');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'upheld', 'dismissed');

-- CreateEnum
CREATE TYPE "AdminActionKind" AS ENUM ('kill', 'dismiss');

-- CreateTable
CREATE TABLE "report" (
    "id" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "detail" VARCHAR(1000),
    "contact" VARCHAR(200),
    "reporterHash" VARCHAR(64) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedBy" VARCHAR(64),

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_action" (
    "id" UUID NOT NULL,
    "kind" "AdminActionKind" NOT NULL,
    "actor" VARCHAR(64) NOT NULL,
    "purchaseId" UUID,
    "reportId" UUID,
    "reason" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_status_createdAt_idx" ON "report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "report_purchaseId_idx" ON "report"("purchaseId");

-- CreateIndex
CREATE INDEX "admin_action_createdAt_idx" ON "admin_action"("createdAt");

-- CreateIndex
CREATE INDEX "admin_action_purchaseId_idx" ON "admin_action"("purchaseId");

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A reviewed report says who reviewed it, and an unreviewed one claims nobody.
-- Half a review is worse than none: it is a record that looks complete.
ALTER TABLE "report"
  ADD CONSTRAINT "report_reviewer_with_review"
  CHECK (("reviewedAt" IS NULL) = ("reviewedBy" IS NULL));

-- An open report has not been reviewed; a closed one has. Without this the
-- admin queue and the audit trail can tell two different stories about the same
-- report, and there is no way to know which is right.
ALTER TABLE "report"
  ADD CONSTRAINT "report_closed_is_reviewed"
  CHECK (("status" = 'open') = ("reviewedAt" IS NULL));

-- An empty reason is not a reason, and a hash of nothing identifies nobody.
ALTER TABLE "report"
  ADD CONSTRAINT "report_reporter_hash_present" CHECK (length("reporterHash") = 64);

-- Optional fields that are present are meant to hold something. Empty string is
-- a value, and it would render as an empty detail box that looks like a bug.
ALTER TABLE "report"
  ADD CONSTRAINT "report_detail_not_blank"
  CHECK ("detail" IS NULL OR length(btrim("detail")) > 0);
ALTER TABLE "report"
  ADD CONSTRAINT "report_contact_not_blank"
  CHECK ("contact" IS NULL OR length(btrim("contact")) > 0);

-- The audit trail's whole value is that every entry answers who, when, what and
-- why. A row missing the "why" is the one that will be quoted back when a
-- takedown is challenged.
ALTER TABLE "admin_action"
  ADD CONSTRAINT "admin_action_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "admin_action"
  ADD CONSTRAINT "admin_action_actor_present" CHECK (length(btrim("actor")) > 0);

-- A kill is always about a listing. A dismissal is always about a report.
ALTER TABLE "admin_action"
  ADD CONSTRAINT "admin_action_subject_matches_kind"
  CHECK (
    ("kind" = 'kill' AND "purchaseId" IS NOT NULL)
    OR ("kind" = 'dismiss' AND "reportId" IS NOT NULL)
  );
