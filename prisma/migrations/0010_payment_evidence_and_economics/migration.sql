-- ===========================================================================
-- Phase 11.4 → 11.7 — Payment evidence, governed outreach, and economics
--
-- ADDITIVE ONLY. No table is dropped, renamed, or altered in a destructive
-- way; no column is removed; no data is rewritten. Every existing writer
-- (`recordRevenueWithAttribution`, the product-factory economics path, and the
-- Phase 11.3 engagement service) keeps working unchanged because every new
-- column carries a default or is nullable.
--
-- What this adds:
--   1. PaymentEvent              — the append-only, replay-guarded evidence
--                                 ledger that makes payment truth auditable.
--   2. ManualPaymentVerification — the controlled admin review path, which is
--                                 only a legitimate source when reviewer,
--                                 reason, evidence and timestamp all exist.
--   3. EngagementCost           — per-engagement cost with an explicit
--                                 ACTUAL / ESTIMATED basis, which is what
--                                 makes per-engagement P&L computable.
--   4. OutreachSend             — provenance and duplicate-send prevention for
--                                 governed outbound communication.
--   5. Revenue columns          — serviceEngagementId / milestoneId /
--                                 paymentEventId attribution plus
--                                 revenueBasis and refund columns, so an
--                                 estimate or a simulation can never be
--                                 summed as if it were realized income.
--   6. ServiceEngagement columns — declared estimated vs realized cost.
--
-- Per docs/phase-11-design.md (Phase 11.0) and the Phase 11.4 → 11.8
-- implementation contract. No new authority is created: a payment still only
-- becomes PAYMENT_VERIFIED through an existing PaymentVerificationSource, and
-- UNPAID → EXECUTING remains impossible.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. PaymentEvent — replay-guarded, append-only payment evidence
-- ---------------------------------------------------------------------------
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'POLAR',
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'RECORDED',
    "rejectionReason" TEXT NOT NULL DEFAULT '',
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationMethod" TEXT NOT NULL DEFAULT 'NONE',
    "amountUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "engagementId" TEXT,
    "milestoneId" TEXT,
    "offerId" TEXT,
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "reversalOfId" TEXT,
    "reversalReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- The replay guard: one row per (provider, providerEventId). A replayed
-- webhook cannot move an engagement state twice or record revenue twice.
CREATE UNIQUE INDEX "PaymentEvent_provider_providerEventId_key" ON "PaymentEvent"("provider", "providerEventId");
CREATE INDEX "PaymentEvent_engagementId_outcome_idx" ON "PaymentEvent"("engagementId", "outcome");
CREATE INDEX "PaymentEvent_outcome_createdAt_idx" ON "PaymentEvent"("outcome", "createdAt");

-- ---------------------------------------------------------------------------
-- 2. ManualPaymentVerification — controlled admin review
-- ---------------------------------------------------------------------------
CREATE TABLE "ManualPaymentVerification" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "milestoneId" TEXT,
    "reviewer" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "outcome" TEXT NOT NULL DEFAULT 'APPROVED',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualPaymentVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManualPaymentVerification_idempotencyKey_key" ON "ManualPaymentVerification"("idempotencyKey");
CREATE INDEX "ManualPaymentVerification_engagementId_idx" ON "ManualPaymentVerification"("engagementId");
CREATE INDEX "ManualPaymentVerification_outcome_createdAt_idx" ON "ManualPaymentVerification"("outcome", "createdAt");

-- ---------------------------------------------------------------------------
-- 3. EngagementCost — actual vs estimated, never conflated
-- ---------------------------------------------------------------------------
CREATE TABLE "EngagementCost" (
    "id" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "basis" TEXT NOT NULL DEFAULT 'ACTUAL',
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementCost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EngagementCost_idempotencyKey_key" ON "EngagementCost"("idempotencyKey");
CREATE INDEX "EngagementCost_engagementId_basis_idx" ON "EngagementCost"("engagementId", "basis");

-- ---------------------------------------------------------------------------
-- 4. OutreachSend — governed outbound communication provenance
-- ---------------------------------------------------------------------------
CREATE TABLE "OutreachSend" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT,
    "engagementId" TEXT,
    "channel" TEXT NOT NULL,
    "recipientDigest" TEXT NOT NULL,
    "subjectDigest" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "screeningResult" TEXT NOT NULL DEFAULT '',
    "approvedBy" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachSend_pkey" PRIMARY KEY ("id")
);

-- A retried outreach is an idempotent no-op, never a second message to a
-- real business.
CREATE UNIQUE INDEX "OutreachSend_idempotencyKey_key" ON "OutreachSend"("idempotencyKey");
CREATE INDEX "OutreachSend_prospectId_createdAt_idx" ON "OutreachSend"("prospectId", "createdAt");
CREATE INDEX "OutreachSend_status_createdAt_idx" ON "OutreachSend"("status", "createdAt");

-- ---------------------------------------------------------------------------
-- 5. Revenue — attribution + evidence basis (additive columns only)
-- ---------------------------------------------------------------------------
-- revenueBasis defaults to ACTUAL so every pre-existing row keeps its current
-- meaning; only writers that explicitly pass another basis change it.
ALTER TABLE "Revenue" ADD COLUMN "revenueBasis" TEXT NOT NULL DEFAULT 'ACTUAL';
ALTER TABLE "Revenue" ADD COLUMN "recognizedUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Revenue" ADD COLUMN "refundTotalUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Revenue" ADD COLUMN "serviceEngagementId" TEXT;
ALTER TABLE "Revenue" ADD COLUMN "milestoneId" TEXT;
ALTER TABLE "Revenue" ADD COLUMN "paymentEventId" TEXT;
ALTER TABLE "Revenue" ADD COLUMN "evidenceBasis" TEXT NOT NULL DEFAULT 'PROVIDER_WEBHOOK';

CREATE INDEX "Revenue_revenueBasis_idx" ON "Revenue"("revenueBasis");
CREATE INDEX "Revenue_serviceEngagementId_idx" ON "Revenue"("serviceEngagementId");
CREATE INDEX "Revenue_milestoneId_idx" ON "Revenue"("milestoneId");

ALTER TABLE "Revenue" ADD CONSTRAINT "Revenue_serviceEngagementId_fkey"
  FOREIGN KEY ("serviceEngagementId") REFERENCES "ServiceEngagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Revenue" ADD CONSTRAINT "Revenue_milestoneId_fkey"
  FOREIGN KEY ("milestoneId") REFERENCES "Milestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Revenue" ADD CONSTRAINT "Revenue_paymentEventId_fkey"
  FOREIGN KEY ("paymentEventId") REFERENCES "PaymentEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. ServiceEngagement — declared estimate vs realized cost
-- ---------------------------------------------------------------------------
-- These are ESTIMATES vs REALIZED totals and are labelled as such wherever
-- they surface. They are not authorities and cannot authorize work.
ALTER TABLE "ServiceEngagement" ADD COLUMN "estimatedCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ServiceEngagement" ADD COLUMN "actualCostUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Foreign keys for the new child tables
-- ---------------------------------------------------------------------------
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- ON DELETE RESTRICT matches the Prisma default for a required relation: an
-- engagement that has financial history is never silently deleted out from
-- under it.
ALTER TABLE "ManualPaymentVerification" ADD CONSTRAINT "ManualPaymentVerification_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EngagementCost" ADD CONSTRAINT "EngagementCost_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutreachSend" ADD CONSTRAINT "OutreachSend_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "ServiceEngagement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
