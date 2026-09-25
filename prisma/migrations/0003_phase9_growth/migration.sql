-- CreateTable
CREATE TABLE "PortfolioItem" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "traffic" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenueUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costsUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "profitUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "experimentCount" INTEGER NOT NULL DEFAULT 0,
    "activeExperimentCount" INTEGER NOT NULL DEFAULT 0,
    "health" TEXT NOT NULL DEFAULT 'NEEDS_DATA',
    "trend" TEXT NOT NULL DEFAULT 'FLAT',
    "confidence" TEXT NOT NULL DEFAULT 'LOW',
    "score" INTEGER NOT NULL DEFAULT 0,
    "explanation" TEXT NOT NULL DEFAULT '',
    "halalStatusSnapshot" TEXT NOT NULL DEFAULT 'HALAL',
    "opportunityStatusSnapshot" TEXT NOT NULL DEFAULT 'IDEA',
    "evidenceStrengthSnapshot" TEXT NOT NULL DEFAULT 'LOW',
    "validationStatusSnapshot" TEXT NOT NULL DEFAULT 'NOT_VALIDATED',
    "productStatusSnapshot" TEXT NOT NULL DEFAULT '',
    "lastActivityAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortfolioItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthExperiment" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "portfolioItemId" TEXT,
    "experimentType" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "baselineValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetValue" DOUBLE PRECISION NOT NULL,
    "budgetUsd" DOUBLE PRECISION NOT NULL,
    "spentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxDurationDays" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "variantVisitors" INTEGER NOT NULL DEFAULT 0,
    "variantConversions" INTEGER NOT NULL DEFAULT 0,
    "variantValueUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "controlValueUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "resultSummary" TEXT NOT NULL DEFAULT '',
    "evidenceType" TEXT NOT NULL DEFAULT 'VERIFIED_DATA',
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "stopLossThreshold" DOUBLE PRECISION NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthDecision" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "experimentId" TEXT,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'VERIFIED_DATA',
    "evidence" TEXT NOT NULL DEFAULT '',
    "decidedBy" TEXT NOT NULL DEFAULT 'growth-engine',
    "metricsJson" TEXT NOT NULL DEFAULT '{}',
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrowthDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearningEntry" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "experimentId" TEXT,
    "hypothesis" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "metric" TEXT NOT NULL DEFAULT '',
    "baselineValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "measuredValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL,
    "context" TEXT NOT NULL DEFAULT '',
    "evidenceType" TEXT NOT NULL DEFAULT 'VERIFIED_DATA',
    "applicability" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceAllocation" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "portfolioItemId" TEXT,
    "monthlyBudgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spentThisMonthUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "perExperimentCapUsd" DOUBLE PRECISION NOT NULL,
    "maxActiveExperiments" INTEGER NOT NULL DEFAULT 2,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortfolioItem_opportunityId_key" ON "PortfolioItem"("opportunityId");

-- CreateIndex
CREATE INDEX "PortfolioItem_health_idx" ON "PortfolioItem"("health");

-- CreateIndex
CREATE INDEX "PortfolioItem_evaluatedAt_idx" ON "PortfolioItem"("evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthExperiment_idempotencyKey_key" ON "GrowthExperiment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GrowthExperiment_opportunityId_status_idx" ON "GrowthExperiment"("opportunityId", "status");

-- CreateIndex
CREATE INDEX "GrowthExperiment_status_endsAt_idx" ON "GrowthExperiment"("status", "endsAt");

-- CreateIndex
CREATE INDEX "GrowthExperiment_correlationId_idx" ON "GrowthExperiment"("correlationId");

-- CreateIndex
CREATE INDEX "GrowthDecision_opportunityId_createdAt_idx" ON "GrowthDecision"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "GrowthDecision_experimentId_idx" ON "GrowthDecision"("experimentId");

-- CreateIndex
CREATE INDEX "GrowthDecision_decision_idx" ON "GrowthDecision"("decision");

-- CreateIndex
CREATE INDEX "LearningEntry_result_createdAt_idx" ON "LearningEntry"("result", "createdAt");

-- CreateIndex
CREATE INDEX "LearningEntry_opportunityId_idx" ON "LearningEntry"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceAllocation_opportunityId_key" ON "ResourceAllocation"("opportunityId");

-- CreateIndex
CREATE INDEX "ResourceAllocation_paused_idx" ON "ResourceAllocation"("paused");

ALTER TABLE "PortfolioItem" ADD CONSTRAINT "PortfolioItem_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GrowthExperiment" ADD CONSTRAINT "GrowthExperiment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GrowthExperiment" ADD CONSTRAINT "GrowthExperiment_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "PortfolioItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GrowthDecision" ADD CONSTRAINT "GrowthDecision_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GrowthDecision" ADD CONSTRAINT "GrowthDecision_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "GrowthExperiment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LearningEntry" ADD CONSTRAINT "LearningEntry_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ResourceAllocation" ADD CONSTRAINT "ResourceAllocation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceAllocation" ADD CONSTRAINT "ResourceAllocation_portfolioItemId_fkey" FOREIGN KEY ("portfolioItemId") REFERENCES "PortfolioItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
