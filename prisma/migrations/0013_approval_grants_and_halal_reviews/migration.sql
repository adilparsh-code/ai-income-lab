-- ===========================================================================
-- Security remediation: ApprovalGrant (single-use, server-issued human
-- approvals) and HalalReview (audited human halal review decisions).
-- Additive only. No existing table is altered, renamed, or dropped.
-- ===========================================================================

-- CreateTable
CREATE TABLE "ApprovalGrant" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "scopeHash" TEXT NOT NULL DEFAULT '',
    "approverSessionId" TEXT NOT NULL,
    "approverEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedBy" TEXT,

    CONSTRAINT "ApprovalGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HalalReview" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "screenStatus" TEXT NOT NULL,
    "screenFlags" TEXT NOT NULL DEFAULT '[]',
    "contentHash" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "reviewerEmail" TEXT NOT NULL,
    "reviewerSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HalalReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalGrant_tokenHash_key" ON "ApprovalGrant"("tokenHash");

-- CreateIndex
CREATE INDEX "ApprovalGrant_subjectType_subjectId_action_idx" ON "ApprovalGrant"("subjectType", "subjectId", "action");

-- CreateIndex
CREATE INDEX "ApprovalGrant_expiresAt_idx" ON "ApprovalGrant"("expiresAt");

-- CreateIndex
CREATE INDEX "HalalReview_opportunityId_createdAt_idx" ON "HalalReview"("opportunityId", "createdAt");
