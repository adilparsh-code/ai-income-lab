-- CreateTable
CREATE TABLE "OpportunityHandoff" (
    "id" TEXT NOT NULL,
    "contractVersion" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "senderIdentity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "assertedEligibility" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "halalStatus" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "jobRunId" TEXT,
    "opportunityId" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpportunityHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityHandoff_idempotencyKey_key" ON "OpportunityHandoff"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OpportunityHandoff_status_receivedAt_idx" ON "OpportunityHandoff"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "OpportunityHandoff_correlationId_idx" ON "OpportunityHandoff"("correlationId");

-- CreateIndex
CREATE INDEX "OpportunityHandoff_eventType_receivedAt_idx" ON "OpportunityHandoff"("eventType", "receivedAt");

-- CreateIndex
CREATE INDEX "OpportunityHandoff_opportunityId_idx" ON "OpportunityHandoff"("opportunityId");

