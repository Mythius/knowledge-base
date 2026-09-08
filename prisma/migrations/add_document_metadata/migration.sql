-- Searchability metadata for KnowledgeDocument — org/year/category/etc, derived from
-- storageUrl and filename. See tools/documentMetadata.ts for the derivation logic and
-- scripts/backfillDocumentMetadata.ts for backfilling pre-existing rows.

CREATE TYPE "FundingStatus" AS ENUM ('CURRENT', 'DEFUNDED_POTENTIAL', 'DEFUNDED_UNLIKELY');
CREATE TYPE "DocProvenance" AS ENUM ('ORG_SUBMITTED', 'CG_INTERNAL', 'REFERENCE_MATERIAL');
CREATE TYPE "ProcessingIssue" AS ENUM ('NEEDS_OCR', 'NEEDS_PASSWORD', 'NEEDS_MANUAL_FIX', 'TRANSIENT_RETRY');

ALTER TABLE "KnowledgeDocument"
  ADD COLUMN IF NOT EXISTS "orgGovId" TEXT,
  ADD COLUMN IF NOT EXISTS "orgName" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingStatus" "FundingStatus",
  ADD COLUMN IF NOT EXISTS "documentYear" INTEGER,
  ADD COLUMN IF NOT EXISTS "documentDate" DATE,
  ADD COLUMN IF NOT EXISTS "category" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "language" TEXT,
  ADD COLUMN IF NOT EXISTS "docProvenance" "DocProvenance",
  ADD COLUMN IF NOT EXISTS "isTemplate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "containsPii" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "processingIssue" "ProcessingIssue";

CREATE INDEX IF NOT EXISTS "KnowledgeDocument_orgGovId_idx" ON "KnowledgeDocument" ("orgGovId");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_fundingStatus_idx" ON "KnowledgeDocument" ("fundingStatus");
CREATE INDEX IF NOT EXISTS "KnowledgeDocument_category_gin_idx" ON "KnowledgeDocument" USING GIN ("category");
