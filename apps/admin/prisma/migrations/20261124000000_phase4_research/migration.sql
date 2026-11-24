-- CreateEnum
CREATE TYPE "ResearchRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "lastResearchedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "research_run" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ResearchRunStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT,
    "scopeType" TEXT NOT NULL,
    "businessIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "discoveryRunId" TEXT,
    "filter" JSONB,
    "targetIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "resolvedAt" TIMESTAMP(3),
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "noWebsiteCount" INTEGER NOT NULL DEFAULT 0,
    "brokenCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "newFactCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
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

    CONSTRAINT "research_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_research" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "requestedUrl" TEXT,
    "finalUrl" TEXT,
    "signals" JSONB,
    "summary" TEXT,
    "factCount" INTEGER NOT NULL DEFAULT 0,
    "conflictFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "researchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_research_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_fact" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
    "usageRestriction" TEXT,
    "firstRunId" TEXT,
    "lastRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "research_fact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "research_run_idempotencyKey_key" ON "research_run"("idempotencyKey");

-- CreateIndex
CREATE INDEX "research_run_status_createdAt_idx" ON "research_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "research_run_createdAt_idx" ON "research_run"("createdAt");

-- CreateIndex
CREATE INDEX "business_research_businessId_researchedAt_idx" ON "business_research"("businessId", "researchedAt");

-- CreateIndex
CREATE INDEX "business_research_status_idx" ON "business_research"("status");

-- CreateIndex
CREATE UNIQUE INDEX "business_research_runId_businessId_key" ON "business_research"("runId", "businessId");

-- CreateIndex
CREATE INDEX "research_fact_businessId_field_idx" ON "research_fact"("businessId", "field");

-- CreateIndex
CREATE INDEX "research_fact_field_verificationStatus_idx" ON "research_fact"("field", "verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "research_fact_businessId_field_normalizedValue_sourceUrl_key" ON "research_fact"("businessId", "field", "normalizedValue", "sourceUrl");

-- AddForeignKey
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_research" ADD CONSTRAINT "business_research_runId_fkey" FOREIGN KEY ("runId") REFERENCES "research_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_research" ADD CONSTRAINT "business_research_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guards Prisma does not model: keep the unique index within B-tree limits and values sane.
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_lengths_check"
  CHECK (char_length("value") <= 1000 AND char_length("normalizedValue") <= 400 AND char_length("sourceUrl") <= 500);
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_confidence_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
ALTER TABLE "research_fact" ADD CONSTRAINT "research_fact_verification_check"
  CHECK ("verificationStatus" IN ('unverified', 'verified', 'conflicting'));
ALTER TABLE "research_run" ADD CONSTRAINT "research_run_scope_check"
  CHECK ("scopeType" IN ('businesses', 'discovery_run', 'filter'));
