-- CreateEnum
CREATE TYPE "EmbedStatus" AS ENUM ('ok', 'unavailable', 'failed');

-- AlterTable
ALTER TABLE "purchase" ADD COLUMN     "clicks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "postUrl" VARCHAR(2048);

-- CreateTable
CREATE TABLE "embed" (
    "id" UUID NOT NULL,
    "postUrl" VARCHAR(2048) NOT NULL,
    "platform" "Platform" NOT NULL,
    "status" "EmbedStatus" NOT NULL,
    "title" VARCHAR(300),
    "authorName" VARCHAR(120),
    "iframeSrc" VARCHAR(2048),
    "iframeWidth" INTEGER,
    "iframeHeight" INTEGER,
    "thumbnail" BYTEA,
    "thumbnailWidth" INTEGER,
    "providerViews" INTEGER,
    "failureReason" VARCHAR(500),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "embed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embed_postUrl_key" ON "embed"("postUrl");

-- CreateIndex
CREATE INDEX "embed_status_resolvedAt_idx" ON "embed"("status", "resolvedAt");

-- Same discipline as the rest of the schema: what the writers intend, expressed
-- where a writer that forgets cannot get past it.

-- A post link is absolute and https, like every other URL in this database.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_post_url_https" CHECK (
    "postUrl" IS NULL OR "postUrl" LIKE 'https://%'
  );

-- Only the three platforms with a public oEmbed endpoint can carry one. A post
-- URL on a GitHub or website listing would be a link nothing will ever resolve.
ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_post_url_embeddable_platform" CHECK (
    "postUrl" IS NULL OR "platform" IN ('youtube', 'tiktok', 'reddit')
  );

ALTER TABLE "purchase"
  ADD CONSTRAINT "purchase_clicks_non_negative" CHECK ("clicks" >= 0);

ALTER TABLE "embed"
  ADD CONSTRAINT "embed_post_url_https" CHECK ("postUrl" LIKE 'https://%');

-- Renderable content exists exactly when the row says it does. Without this a
-- row could claim ok with nothing to show, and slot 01 would render an empty
-- frame — the dead card at number one that #20 exists to prevent.
ALTER TABLE "embed"
  ADD CONSTRAINT "embed_renderable_when_ok" CHECK (
    ("status" = 'ok') = ("iframeSrc" IS NOT NULL)
  );

ALTER TABLE "embed"
  ADD CONSTRAINT "embed_iframe_src_https" CHECK (
    "iframeSrc" IS NULL OR "iframeSrc" LIKE 'https://%'
  );

-- A non-ok row explains itself, and holds nothing renderable.
ALTER TABLE "embed"
  ADD CONSTRAINT "embed_reason_when_not_ok" CHECK (
    "status" = 'ok' OR ("failureReason" IS NOT NULL AND length("failureReason") > 0)
  );

ALTER TABLE "embed"
  ADD CONSTRAINT "embed_no_content_unless_ok" CHECK (
    "status" = 'ok' OR ("thumbnail" IS NULL AND "title" IS NULL AND "providerViews" IS NULL)
  );

-- A count is either a real number or absent. A negative one is neither.
ALTER TABLE "embed"
  ADD CONSTRAINT "embed_views_non_negative" CHECK (
    "providerViews" IS NULL OR "providerViews" >= 0
  );

ALTER TABLE "embed"
  ADD CONSTRAINT "embed_attempts_non_negative" CHECK ("attempts" >= 0);

ALTER TABLE "embed"
  ADD CONSTRAINT "embed_dimensions_positive" CHECK (
    ("iframeWidth" IS NULL OR "iframeWidth" > 0)
    AND ("iframeHeight" IS NULL OR "iframeHeight" > 0)
    AND ("thumbnailWidth" IS NULL OR "thumbnailWidth" > 0)
  );
