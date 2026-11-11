-- ============================================================================
-- Phase 4.2C — multi-tenant handoff authorization.
--
-- Additive only. No existing table is renamed or dropped and no existing
-- column is altered, so existing rows stay valid:
--   * Tenant / TenantMembership are new tables.
--   * OpportunityHandoff.tenantId and OpportunityHandoff.payloadHash are new
--     NULLABLE columns (rows written before this migration keep NULL).
--   * Opportunity.tenantId is a new NULLABLE column.
--
-- Backfill strategy (deliberate): no automatic backfill. Existing rows have no
-- trustworthy tenant provenance, so they stay NULL and are treated as
-- LEGACY_UNSCOPED by every tenant-scoped read. Operators assign ownership
-- explicitly after verifying it; inventing an owner would be worse than NULL.
--
-- Rollback: drop the two indexes, the new columns and the two new tables. No
-- data belonging to pre-existing tables is touched beyond those columns.
-- ============================================================================

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantMembership" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "principalFingerprint" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'SENDER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantMembership_pkey" PRIMARY KEY ("id")
);

-- AlterTable (additive, nullable)
ALTER TABLE "Opportunity" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "OpportunityHandoff" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "OpportunityHandoff" ADD COLUMN "payloadHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");
CREATE UNIQUE INDEX "TenantMembership_tenantId_principalFingerprint_key" ON "TenantMembership"("tenantId", "principalFingerprint");
CREATE INDEX "TenantMembership_principalFingerprint_status_idx" ON "TenantMembership"("principalFingerprint", "status");
CREATE INDEX "Opportunity_tenantId_idx" ON "Opportunity"("tenantId");
CREATE INDEX "OpportunityHandoff_tenantId_idx" ON "OpportunityHandoff"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantMembership" ADD CONSTRAINT "TenantMembership_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
