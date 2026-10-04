-- ===========================================================================
-- Phase 11.2 + 11.3 — Governed Income Pipeline (additive only)
-- Offer + Proposal + immutable ProposalVersion + ScopeItem + ScopeChangeRequest
-- (11.2), and ServiceEngagement + Milestone + Deliverable + ServiceIssue (11.3).
--
-- Per docs/phase-11-design.md (Phase 11.0). No existing table is altered,
-- renamed or dropped; no destructive SQL. These tables hold NO execution
-- authority: payment truth is reachable only through a
-- PaymentVerificationSource, and client messages remain DATA, never authority.
-- ===========================================================================

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "scopeSummary" TEXT NOT NULL DEFAULT '',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "estimatedEffortHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedMargin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "opportunityId" TEXT,
    "productId" TEXT,
    "halalStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "riskState" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "paymentState" TEXT NOT NULL DEFAULT 'NOT_PAYMENT_VERIFIED',
    "paymentVerificationSource" TEXT,
    "paymentVerificationRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "approvalState" TEXT NOT NULL DEFAULT 'NOT_APPROVED',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "currentVersionId" TEXT,
    "approvedVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalVersion" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "scopeItems" TEXT NOT NULL DEFAULT '[]',
    "deliverables" TEXT NOT NULL DEFAULT '[]',
    "exclusions" TEXT NOT NULL DEFAULT '[]',
    "assumptions" TEXT NOT NULL DEFAULT '[]',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "estimatedTimeline" TEXT NOT NULL DEFAULT '',
    "paymentTerms" TEXT NOT NULL DEFAULT '',
    "revisionAllowance" INTEGER NOT NULL DEFAULT 2,
    "validityDays" INTEGER NOT NULL DEFAULT 30,
    "halalStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "identityDisclosure" TEXT NOT NULL DEFAULT 'AI-assisted business operator',
    "createdBy" TEXT NOT NULL,
    "createdSource" TEXT NOT NULL DEFAULT 'ADMIN',
    "changeReason" TEXT NOT NULL DEFAULT '',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScopeItem" (
    "id" TEXT NOT NULL,
    "proposalVersionId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "classification" TEXT NOT NULL DEFAULT 'IN_SCOPE',
    "detail" TEXT NOT NULL DEFAULT '',
    "estimatedHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScopeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScopeChangeRequest" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "proposalVersionId" TEXT,
    "requestedSummary" TEXT NOT NULL,
    "requestedDetail" TEXT NOT NULL DEFAULT '',
    "classification" TEXT NOT NULL DEFAULT 'SCOPE_CHANGE_REQUEST',
    "status" TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "sourceMessageId" TEXT,
    "sourceFlag" TEXT,
    "estimatedHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiresPayment" BOOLEAN NOT NULL DEFAULT true,
    "resolvedVersionId" TEXT,
    "resolutionNote" TEXT NOT NULL DEFAULT '',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScopeChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceEngagement" (
    "id" TEXT NOT NULL,
    "engagementType" TEXT NOT NULL DEFAULT 'CLIENT_SERVICE',
    "offerId" TEXT,
    "proposalId" TEXT,
    "proposalVersionId" TEXT,
    "opportunityId" TEXT,
    "prospectId" TEXT,
    "title" TEXT NOT NULL,
    "scopeSummary" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'NO_COMMITMENT',
    "paymentState" TEXT NOT NULL DEFAULT 'NOT_DUE',
    "verificationSource" TEXT,
    "providerRef" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "exposureCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lowRiskExceptionApplied" BOOLEAN NOT NULL DEFAULT false,
    "totalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "workAuthorizedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceEngagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "percent" INTEGER NOT NULL DEFAULT 0,
    "amountUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentState" TEXT NOT NULL DEFAULT 'NOT_DUE',
    "verificationSource" TEXT,
    "providerRef" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "acceptanceEvidence" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "milestoneKey" TEXT,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "artifactRefs" TEXT NOT NULL DEFAULT '[]',
    "revisionCount" INTEGER NOT NULL DEFAULT 0,
    "revisionLimit" INTEGER NOT NULL DEFAULT 2,
    "qaSummary" TEXT NOT NULL DEFAULT '',
    "deliveredAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptanceEvidence" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceIssue" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL DEFAULT '',
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "requiresHuman" BOOLEAN NOT NULL DEFAULT true,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "resolutionNote" TEXT NOT NULL DEFAULT '',
    "correlationId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Offer_type_status_idx" ON "Offer"("type", "status");

-- CreateIndex
CREATE INDEX "Offer_opportunityId_idx" ON "Offer"("opportunityId");

-- CreateIndex
CREATE INDEX "Offer_productId_idx" ON "Offer"("productId");

-- CreateIndex
CREATE INDEX "Proposal_prospectId_state_idx" ON "Proposal"("prospectId", "state");

-- CreateIndex
CREATE INDEX "Proposal_state_idx" ON "Proposal"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalVersion_proposalId_version_key" ON "ProposalVersion"("proposalId", "version");

-- CreateIndex
CREATE INDEX "ProposalVersion_proposalId_createdAt_idx" ON "ProposalVersion"("proposalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScopeItem_proposalVersionId_itemKey_key" ON "ScopeItem"("proposalVersionId", "itemKey");

-- CreateIndex
CREATE INDEX "ScopeItem_classification_idx" ON "ScopeItem"("classification");

-- CreateIndex
CREATE INDEX "ScopeChangeRequest_proposalId_status_idx" ON "ScopeChangeRequest"("proposalId", "status");

-- CreateIndex
CREATE INDEX "ServiceEngagement_state_idx" ON "ServiceEngagement"("state");

-- CreateIndex
CREATE INDEX "ServiceEngagement_engagementType_state_idx" ON "ServiceEngagement"("engagementType", "state");

-- CreateIndex
CREATE INDEX "ServiceEngagement_prospectId_idx" ON "ServiceEngagement"("prospectId");

-- CreateIndex
CREATE INDEX "ServiceEngagement_opportunityId_idx" ON "ServiceEngagement"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "Milestone_engagementId_key_key" ON "Milestone"("engagementId", "key");

-- CreateIndex
CREATE INDEX "Milestone_paymentState_idx" ON "Milestone"("paymentState");

-- CreateIndex
CREATE INDEX "Deliverable_engagementId_state_idx" ON "Deliverable"("engagementId", "state");

-- CreateIndex
CREATE INDEX "ServiceIssue_engagementId_idx" ON "ServiceIssue"("engagementId");

-- CreateIndex
CREATE INDEX "ServiceIssue_issueType_status_idx" ON "ServiceIssue"("issueType", "status");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalVersion" ADD CONSTRAINT "ProposalVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeItem" ADD CONSTRAINT "ScopeItem_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "ProposalVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeChangeRequest" ADD CONSTRAINT "ScopeChangeRequest_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScopeChangeRequest" ADD CONSTRAINT "ScopeChangeRequest_proposalVersionId_fkey" FOREIGN KEY ("proposalVersionId") REFERENCES "ProposalVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEngagement" ADD CONSTRAINT "ServiceEngagement_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEngagement" ADD CONSTRAINT "ServiceEngagement_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceEngagement" ADD CONSTRAINT "ServiceEngagement_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceIssue" ADD CONSTRAINT "ServiceIssue_engagementId_fkey" FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;