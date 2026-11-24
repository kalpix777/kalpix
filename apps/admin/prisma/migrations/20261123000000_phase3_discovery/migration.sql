-- CreateEnum
CREATE TYPE "DiscoveryRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('NEW', 'REVIEWED', 'QUALIFIED', 'DISQUALIFIED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "discovery_run" (
    "id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "categories" TEXT[],
    "provider" TEXT NOT NULL,
    "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'queued',
    "idempotencyKey" TEXT,
    "areaDisplayName" TEXT,
    "areaSource" TEXT,
    "bboxSouth" DOUBLE PRECISION,
    "bboxWest" DOUBLE PRECISION,
    "bboxNorth" DOUBLE PRECISION,
    "bboxEast" DOUBLE PRECISION,
    "completedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "attribution" TEXT,
    "startedById" TEXT,
    "startedByLabel" TEXT NOT NULL,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "osmType" TEXT,
    "osmId" TEXT,
    "alternateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "houseNumber" TEXT,
    "street" TEXT,
    "locality" TEXT,
    "city" TEXT,
    "district" TEXT,
    "state" TEXT,
    "postcode" TEXT,
    "country" TEXT,
    "addressFull" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "email" TEXT,
    "openingHours" TEXT,
    "hasWebsite" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
    "license" TEXT,
    "usageRestrictions" TEXT,
    "rawTags" JSONB,
    "firstRunId" TEXT,
    "lastRunId" TEXT,
    "status" "BusinessStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geocode_cache" (
    "key" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "south" DOUBLE PRECISION NOT NULL,
    "west" DOUBLE PRECISION NOT NULL,
    "north" DOUBLE PRECISION NOT NULL,
    "east" DOUBLE PRECISION NOT NULL,
    "sourceUrl" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "discovery_run_idempotencyKey_key" ON "discovery_run"("idempotencyKey");

-- CreateIndex
CREATE INDEX "discovery_run_status_createdAt_idx" ON "discovery_run"("status", "createdAt");

-- CreateIndex
CREATE INDEX "discovery_run_createdAt_idx" ON "discovery_run"("createdAt");

-- CreateIndex
CREATE INDEX "business_category_idx" ON "business"("category");

-- CreateIndex
CREATE INDEX "business_hasWebsite_idx" ON "business"("hasWebsite");

-- CreateIndex
CREATE INDEX "business_status_idx" ON "business"("status");

-- CreateIndex
CREATE INDEX "business_lat_lon_idx" ON "business"("lat", "lon");

-- CreateIndex
CREATE INDEX "business_createdAt_idx" ON "business"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "business_provider_providerId_key" ON "business"("provider", "providerId");

-- AddForeignKey
ALTER TABLE "discovery_run" ADD CONSTRAINT "discovery_run_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
