-- CreateEnum
CREATE TYPE "QualificationRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "latestScore" INTEGER,
ADD COLUMN     "latestTier" TEXT,
ADD COLUMN     "qualifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "research_fact" ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "verificationEvidence" JSONB,
ADD COLUMN     "verificationMethod" TEXT,
ADD COLUMN     "verificationOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT,
ADD COLUMN     "verifiedByLabel" TEXT;

-- CreateTable
CREATE TABLE "qualification_run" (
    "id" TEXT NOT NULL,
    "status" "QualificationRunStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT,
    "scopeType" TEXT NOT NULL,
    "businessIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveryRunId" TEXT,
    "researchRunId" TEXT,
    "filter" JSONB,
    "targetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "aiProvider" TEXT,
    "promptVersion" TEXT,
    "rulesVersion" TEXT NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "hotCount" INTEGER NOT NULL DEFAULT 0,
    "warmCount" INTEGER NOT NULL DEFAULT 0,
    "coldCount" INTEGER NOT NULL DEFAULT 0,
    "disqualifiedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "factsCheckedCount" INTEGER NOT NULL DEFAULT 0,
    "factsVerifiedCount" INTEGER NOT NULL DEFAULT 0,
    "factsInvalidCount" INTEGER NOT NULL DEFAULT 0,
    "dnsLookupCount" INTEGER NOT NULL DEFAULT 0,
    "aiOkCount" INTEGER NOT NULL DEFAULT 0,
    "aiErrorCount" INTEGER NOT NULL DEFAULT 0,
    "aiInputTokens" INTEGER NOT NULL DEFAULT 0,
    "aiOutputTokens" INTEGER NOT NULL DEFAULT 0,
    "aiCostMinor" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "errors" JSONB,
    "startedById" TEXT,
    "startedByLabel" TEXT NOT NULL,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qualification_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_qualification" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "disqualifiedReason" TEXT,
    "duplicateOfId" TEXT,
    "operatingStatus" TEXT NOT NULL,
    "verification" JSONB NOT NULL,
    "researchId" TEXT,
    "isMock" BOOLEAN NOT NULL DEFAULT false,
    "aiStatus" TEXT NOT NULL DEFAULT 'off',
    "aiSummary" TEXT,
    "aiPitch" TEXT,
    "aiRisks" JSONB,
    "aiError" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiPromptVersion" TEXT,
    "aiInputTokens" INTEGER,
    "aiOutputTokens" INTEGER,
    "aiCostMinor" INTEGER,
    "aiIsMock" BOOLEAN NOT NULL DEFAULT false,
    "qualifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_qualification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qualification_run_idempotencyKey_key" ON "qualification_run"("idempotencyKey");

-- CreateIndex
CREATE INDEX "qualification_run_status_createdAt_idx" ON "qualification_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "qualification_run_createdAt_idx" ON "qualification_run"("createdAt");

-- CreateIndex
CREATE INDEX "business_qualification_businessId_qualifiedAt_idx" ON "business_qualification"("businessId", "qualifiedAt");

-- CreateIndex
CREATE INDEX "business_qualification_tier_score_idx" ON "business_qualification"("tier", "score");

-- CreateIndex
CREATE UNIQUE INDEX "business_qualification_runId_businessId_key" ON "business_qualification"("runId", "businessId");

-- CreateIndex
CREATE INDEX "business_latestTier_latestScore_idx" ON "business"("latestTier", "latestScore");

-- AddForeignKey
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_run" ADD CONSTRAINT "qualification_run_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_runId_fkey" FOREIGN KEY ("runId") REFERENCES "qualification_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guards Prisma does not model.
-- Phase 5 adds "invalid" to the fact verification states.
ALTER TABLE "research_fact" DROP CONSTRAINT "research_fact_verification_check";
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_verification_check"
  CHECK ("verificationStatus" IN ('unverified', 'verified', 'conflicting', 'invalid'));
-- A manual override always records who and why.
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_override_check"
  CHECK (NOT "verificationOverride" OR ("verifiedByLabel" IS NOT NULL AND "overrideReason" IS NOT NULL AND "verifiedAt" IS NOT NULL));
ALTER TABLE "qualification_run" ADD CONSTRAINT "qualification_run_scope_check"
  CHECK ("scopeType" IN ('businesses', 'discovery_run', 'research_run', 'filter'));
ALTER TABLE "qualification_run" ADD CONSTRAINT "qualification_run_ai_check"
  CHECK (("aiEnabled" AND "aiProvider" IS NOT NULL) OR (NOT "aiEnabled" AND "aiProvider" IS NULL));
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_score_check"
  CHECK ("score" >= 0 AND "score" <= 100);
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_tier_check"
  CHECK ("tier" IN ('hot', 'warm', 'cold', 'disqualified'));
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_dq_check"
  CHECK (("tier" = 'disqualified') = ("disqualifiedReason" IS NOT NULL));
ALTER TABLE "business_qualification" ADD CONSTRAINT "business_qualification_ai_status_check"
  CHECK ("aiStatus" IN ('off', 'skipped', 'ok', 'error'));
ALTER TABLE "business" ADD CONSTRAINT "business_latest_qualification_check"
  CHECK (("latestScore" IS NULL OR ("latestScore" >= 0 AND "latestScore" <= 100))
     AND ("latestTier" IS NULL OR "latestTier" IN ('hot', 'warm', 'cold', 'disqualified')));
