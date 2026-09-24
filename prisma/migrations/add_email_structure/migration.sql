-- Structured email fields on KnowledgeDocument + full-text search over KnowledgeChunk.
-- See tools/emailParse.ts for how the email* columns are derived, and
-- scripts/backfillEmailFields.ts to populate them for rows ingested before this.
--
-- Everything here is additive and idempotent (IF NOT EXISTS / OR REPLACE). Index names
-- match Prisma's defaults for the @@index declarations in schema.prisma, so a later
-- `bunx prisma db push` sees them as already in sync instead of dropping/recreating.
-- The trigger + function are invisible to Prisma and survive db push.

DO $$ BEGIN
  CREATE TYPE "EmailDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN IF NOT EXISTS "emailThreadId" TEXT,
  ADD COLUMN IF NOT EXISTS "emailThreadKey" TEXT,
  ADD COLUMN IF NOT EXISTS "emailFrom" TEXT,
  ADD COLUMN IF NOT EXISTS "emailTo" TEXT,
  ADD COLUMN IF NOT EXISTS "emailCc" TEXT,
  ADD COLUMN IF NOT EXISTS "emailSentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "emailDirection" "EmailDirection",
  ADD COLUMN IF NOT EXISTS "emailBody" TEXT;

CREATE INDEX IF NOT EXISTS "KnowledgeDocument_orgGovId_emailSentAt_idx"
  ON "KnowledgeDocument" ("orgGovId", "emailSentAt");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_emailThreadId_idx"
  ON "KnowledgeDocument" ("emailThreadId");

-- ── Full-text search on chunks ────────────────────────────────────────────────
ALTER TABLE "KnowledgeChunk" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

CREATE OR REPLACE FUNCTION "KnowledgeChunk_searchVector_update"() RETURNS trigger AS $$
BEGIN
  NEW."searchVector" := to_tsvector('english', coalesce(NEW."editedContent", NEW."content", ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "KnowledgeChunk_searchVector_trg" ON "KnowledgeChunk";
CREATE TRIGGER "KnowledgeChunk_searchVector_trg"
  BEFORE INSERT OR UPDATE OF "content", "editedContent" ON "KnowledgeChunk"
  FOR EACH ROW EXECUTE FUNCTION "KnowledgeChunk_searchVector_update"();

-- Backfill existing chunks (~71k rows as of 2026-09; takes seconds).
UPDATE "KnowledgeChunk"
  SET "searchVector" = to_tsvector('english', coalesce("editedContent", "content", ''))
  WHERE "searchVector" IS NULL;

CREATE INDEX IF NOT EXISTS "KnowledgeChunk_searchVector_idx"
  ON "KnowledgeChunk" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_documentId_idx"
  ON "KnowledgeChunk" ("documentId");
