-- Phase 4.2D — tenant isolation propagation.
--
-- Additive only. Every new column is NULLable, every new table is new, and no
-- existing row is rewritten. There is deliberately NO automatic backfill: a
-- legacy row is NOT assigned to an arbitrary tenant. Legacy rows keep
-- tenantId = NULL and are readable only through the explicit "legacy" scope
-- (see src/lib/tenancy/scope.ts), never by a tenant member.
--
-- Ownership propagation:
--   Tenant -> TenantMembership -> Opportunity -> (JobRun | PipelineRun |
--   ResearchResult | HumanReview | ApprovalGrant | ProductSpecification)
--   ProductGeneration/ProductVersion/ProductPackage inherit through
--   ProductSpecification. Product inherits through Opportunity.
--
-- ROLLBACK (safe, data-preserving): every statement below is reversed by
--   dropping the new indexes/columns/table. Dropping the columns discards only
--   the tenancy attribution, not the business records. To roll back:
--     DROP TABLE "ResearchResult";
--     DROP INDEX ...; ALTER TABLE ... DROP COLUMN "tenantId";
--   No existing column, constraint, or row is modified by this migration.

-- 1. Research artifact (the provenance link RESEARCH -> VALIDATION).
CREATE TABLE "ResearchResult" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "tenantId" TEXT,
    "pipelineRunId" TEXT,
    "jobId" TEXT,
    "correlationId" TEXT,
    "objective" TEXT NOT NULL,
    "findings" TEXT NOT NULL DEFAULT '{}',
    "evidenceType" TEXT NOT NULL DEFAULT 'AI_INFERENCE',
    "provenance" TEXT NOT NULL DEFAULT '',
    "capabilityStatus" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchResult_opportunityId_createdAt_idx" ON "ResearchResult"("opportunityId", "createdAt");
CREATE INDEX "ResearchResult_tenantId_createdAt_idx" ON "ResearchResult"("tenantId", "createdAt");
CREATE INDEX "ResearchResult_pipelineRunId_idx" ON "ResearchResult"("pipelineRunId");

ALTER TABLE "ResearchResult"
    ADD CONSTRAINT "ResearchResult_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Job ownership.
ALTER TABLE "JobRun" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "JobRun_tenantId_createdAt_idx" ON "JobRun"("tenantId", "createdAt");

-- 3. Pipeline run ownership.
ALTER TABLE "PipelineRun" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "PipelineRun_tenantId_createdAt_idx" ON "PipelineRun"("tenantId", "createdAt");
CREATE INDEX "PipelineRun_opportunityId_idx" ON "PipelineRun"("opportunityId");

-- 4. Security audit scoping (global/legacy events stay NULL).
ALTER TABLE "SecurityEvent" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "SecurityEvent_tenantId_createdAt_idx" ON "SecurityEvent"("tenantId", "createdAt");

-- 5. Product specification ownership (generation/version/package inherit).
ALTER TABLE "ProductSpecification" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "ProductSpecification_tenantId_createdAt_idx" ON "ProductSpecification"("tenantId", "createdAt");

-- 6. Human review ownership.
ALTER TABLE "HumanReview" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "HumanReview_tenantId_status_createdAt_idx" ON "HumanReview"("tenantId", "status", "createdAt");

-- 7. Approval grant ownership.
ALTER TABLE "ApprovalGrant" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "ApprovalGrant_tenantId_createdAt_idx" ON "ApprovalGrant"("tenantId", "createdAt");

-- Backfill policy: NONE. See prisma/scripts/adopt-legacy-tenant.mjs for the
-- explicit, confirmed, audited operator action that adopts existing rows into a
-- tenant. Until an operator runs it, legacy rows remain NULL-tenant and are
-- unreachable for tenant members.
