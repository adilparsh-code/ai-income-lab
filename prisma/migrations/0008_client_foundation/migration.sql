-- ============================================================================
-- Phase 11.1 — Secure Income Foundation (additive only)
-- Prospect + Conversation + Message: the earliest client/service income-loop
-- foundation per docs/phase-11-design.md (Phase 11.0). No existing table is
-- altered or dropped; no destructive SQL. These tables hold NO execution
-- authority — client messages are DATA, never authority.
-- ============================================================================

-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "lifecycleState" TEXT NOT NULL DEFAULT 'NEW',
    "riskState" TEXT NOT NULL DEFAULT 'NEW',
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "emailDomain" TEXT,
    "website" TEXT,
    "businessInfo" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL,
    "sourceProvider" TEXT,
    "sourceRef" TEXT,
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "paidCount" INTEGER NOT NULL DEFAULT 0,
    "failedPaymentCount" INTEGER NOT NULL DEFAULT 0,
    "disputeCount" INTEGER NOT NULL DEFAULT 0,
    "chargebackCount" INTEGER NOT NULL DEFAULT 0,
    "cancellationCount" INTEGER NOT NULL DEFAULT 0,
    "scopeChanges" INTEGER NOT NULL DEFAULT 0,
    "revisionOverruns" INTEGER NOT NULL DEFAULT 0,
    "abuseFlags" INTEGER NOT NULL DEFAULT 0,
    "injectionFlags" INTEGER NOT NULL DEFAULT 0,
    "lifetimePaidUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastRiskEvaluatedAt" TIMESTAMP(3),
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "contactAttempts" INTEGER NOT NULL DEFAULT 0,
    "suppressionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "injectionFlagCount" INTEGER NOT NULL DEFAULT 0,
    "prospectMessageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerStatus" TEXT,
    "trustFlags" TEXT NOT NULL DEFAULT '[]',
    "treatedAs" TEXT NOT NULL DEFAULT 'DATA',
    "immutable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prospect_email_key" ON "Prospect"("email");

-- CreateIndex
CREATE INDEX "Prospect_lifecycleState_idx" ON "Prospect"("lifecycleState");

-- CreateIndex
CREATE INDEX "Prospect_riskState_idx" ON "Prospect"("riskState");

-- CreateIndex
CREATE INDEX "Prospect_optedOut_idx" ON "Prospect"("optedOut");

-- CreateIndex
CREATE INDEX "Conversation_prospectId_state_idx" ON "Conversation"("prospectId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_providerMessageId_key" ON "Message"("conversationId", "providerMessageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
