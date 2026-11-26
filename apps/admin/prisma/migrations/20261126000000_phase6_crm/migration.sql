-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('new', 'contacted', 'interested', 'demo_requested', 'proposal_sent', 'negotiating', 'won', 'lost', 'nurture');

-- CreateEnum
CREATE TYPE "LeadPriority" AS ENUM ('low', 'normal', 'high');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('qualification', 'manual', 'import');

-- CreateEnum
CREATE TYPE "LeadActivityType" AS ENUM ('note', 'call_logged', 'meeting_logged', 'stage_change', 'assignment', 'task_done', 'system');

-- CreateEnum
CREATE TYPE "LeadTaskStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('ok', 'do_not_contact', 'opted_out');

-- AlterTable
ALTER TABLE "business" ADD COLUMN     "contactStatus" "ContactStatus" NOT NULL DEFAULT 'ok',
ADD COLUMN     "contactStatusAt" TIMESTAMP(3),
ADD COLUMN     "contactStatusById" TEXT,
ADD COLUMN     "contactStatusByLabel" TEXT,
ADD COLUMN     "contactStatusReason" TEXT,
ADD COLUMN     "lawfulBasisNote" TEXT;

-- CreateTable
CREATE TABLE "lead" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "stage" "LeadStage" NOT NULL DEFAULT 'new',
    "assigneeId" TEXT,
    "priority" "LeadPriority" NOT NULL DEFAULT 'normal',
    "valueEstimatePaise" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "lostReason" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "source" "LeadSource" NOT NULL,
    "qualificationId" TEXT,
    "promotedTier" TEXT,
    "createdById" TEXT,
    "createdByLabel" TEXT NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_stage_history" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStage" "LeadStage",
    "toStage" "LeadStage" NOT NULL,
    "byId" TEXT,
    "byLabel" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "lead_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_contact" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "personName" TEXT,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "whatsapp" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sourceFactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activity" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadActivityType" NOT NULL,
    "authorId" TEXT,
    "authorLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "lead_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_task" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "status" "LeadTaskStatus" NOT NULL DEFAULT 'open',
    "createdById" TEXT,
    "createdByLabel" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completedByLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tag_link" (
    "leadId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tag_link_pkey" PRIMARY KEY ("leadId","tagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_businessId_key" ON "lead"("businessId");

-- CreateIndex
CREATE INDEX "lead_stage_assigneeId_idx" ON "lead"("stage", "assigneeId");

-- CreateIndex
CREATE INDEX "lead_assigneeId_idx" ON "lead"("assigneeId");

-- CreateIndex
CREATE INDEX "lead_nextFollowUpAt_idx" ON "lead"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "lead_lastActivityAt_idx" ON "lead"("lastActivityAt");

-- CreateIndex
CREATE INDEX "lead_createdAt_idx" ON "lead"("createdAt");

-- CreateIndex
CREATE INDEX "lead_stage_history_leadId_at_idx" ON "lead_stage_history"("leadId", "at");

-- CreateIndex
CREATE INDEX "lead_contact_leadId_idx" ON "lead_contact"("leadId");

-- CreateIndex
CREATE INDEX "lead_activity_leadId_createdAt_idx" ON "lead_activity"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "lead_task_leadId_status_idx" ON "lead_task"("leadId", "status");

-- CreateIndex
CREATE INDEX "lead_task_assigneeId_status_idx" ON "lead_task"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lead_tag_key_key" ON "lead_tag"("key");

-- CreateIndex
CREATE INDEX "lead_tag_link_tagId_idx" ON "lead_tag_link"("tagId");

-- AddForeignKey
ALTER TABLE "business" ADD CONSTRAINT "business_contactStatusById_fkey" FOREIGN KEY ("contactStatusById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_byId_fkey" FOREIGN KEY ("byId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_contact" ADD CONSTRAINT "lead_contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_contact" ADD CONSTRAINT "lead_contact_sourceFactId_fkey" FOREIGN KEY ("sourceFactId") REFERENCES "research_fact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activity" ADD CONSTRAINT "lead_activity_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tag_link" ADD CONSTRAINT "lead_tag_link_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tag_link" ADD CONSTRAINT "lead_tag_link_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "lead_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Guards Prisma does not model.
-- Lead: a lost lead always says why; estimates are non-negative; version starts at 1.
ALTER TABLE "lead" ADD CONSTRAINT "lead_lost_reason_check"
  CHECK ("stage" <> 'lost' OR ("lostReason" IS NOT NULL AND length(btrim("lostReason")) > 0));
ALTER TABLE "lead" ADD CONSTRAINT "lead_value_check"
  CHECK ("valueEstimatePaise" IS NULL OR "valueEstimatePaise" >= 0);
ALTER TABLE "lead" ADD CONSTRAINT "lead_version_check" CHECK ("version" >= 1);
ALTER TABLE "lead" ADD CONSTRAINT "lead_promoted_tier_check"
  CHECK ("promotedTier" IS NULL OR "promotedTier" IN ('hot', 'warm', 'cold'));
-- Consent: anything but "ok" records why, who and when (DPDP Act: DNC blocks future outreach).
ALTER TABLE "business" ADD CONSTRAINT "business_contact_status_check"
  CHECK ("contactStatus" = 'ok' OR ("contactStatusReason" IS NOT NULL AND "contactStatusByLabel" IS NOT NULL AND "contactStatusAt" IS NOT NULL));
-- Contacts: at least a name or one channel; one primary contact per lead.
ALTER TABLE "lead_contact" ADD CONSTRAINT "lead_contact_nonempty_check"
  CHECK (COALESCE("personName", "phone", "email", "whatsapp") IS NOT NULL);
CREATE UNIQUE INDEX "lead_contact_one_primary_idx" ON "lead_contact"("leadId") WHERE "isPrimary";
-- Tasks: done iff completed; open tasks by due date.
ALTER TABLE "lead_task" ADD CONSTRAINT "lead_task_completed_check"
  CHECK (("status" = 'done') = ("completedAt" IS NOT NULL));
CREATE INDEX "lead_task_open_due_idx" ON "lead_task"("dueAt") WHERE "status" = 'open';
-- Tags: unique case-insensitively through key = lower(trim(name)).
ALTER TABLE "lead_tag" ADD CONSTRAINT "lead_tag_key_check"
  CHECK ("key" = lower(btrim("name")) AND length("key") BETWEEN 1 AND 40);

-- lead_stage_history is append-only. Rows leave only through ON DELETE CASCADE from their lead,
-- and change only through ON DELETE SET NULL of a user (both run at trigger depth > 1).
CREATE OR REPLACE FUNCTION lead_stage_history_block_mutation() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'lead_stage_history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lead_stage_history_no_update BEFORE UPDATE ON "lead_stage_history"
  FOR EACH ROW EXECUTE FUNCTION lead_stage_history_block_mutation();
CREATE TRIGGER lead_stage_history_no_delete BEFORE DELETE ON "lead_stage_history"
  FOR EACH ROW EXECUTE FUNCTION lead_stage_history_block_mutation();

-- lead_activity is append-only too, except that a note's body may be edited (editedAt set) within
-- 15 minutes of creation. The author check is in the application (apps/admin/src/server/crm.ts).
CREATE OR REPLACE FUNCTION lead_activity_guard() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lead_activity is append-only';
  END IF;
  IF OLD."type" <> 'note'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."leadId" IS DISTINCT FROM OLD."leadId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."authorId" IS DISTINCT FROM OLD."authorId"
     OR NEW."authorLabel" IS DISTINCT FROM OLD."authorLabel"
     OR NEW."metadata"::text IS DISTINCT FROM OLD."metadata"::text
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."editedAt" IS NULL THEN
    RAISE EXCEPTION 'lead_activity is append-only (only a note body can be edited)';
  END IF;
  IF OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '15 minutes' THEN
    RAISE EXCEPTION 'notes can be edited only within 15 minutes';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lead_activity_no_update BEFORE UPDATE ON "lead_activity"
  FOR EACH ROW EXECUTE FUNCTION lead_activity_guard();
CREATE TRIGGER lead_activity_no_delete BEFORE DELETE ON "lead_activity"
  FOR EACH ROW EXECUTE FUNCTION lead_activity_guard();
