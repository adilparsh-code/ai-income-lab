-- Phase 8 — additive operations layer. Never drops or rewrites existing tables.

-- CreateTable
CREATE TABLE "AgentMission" (
    "id" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "opportunityId" TEXT,
    "agentType" TEXT NOT NULL,
    "constraints" TEXT NOT NULL DEFAULT '[]',
    "budgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allowedCapabilities" TEXT NOT NULL DEFAULT '[]',
    "expectedOutput" TEXT NOT NULL DEFAULT '',
    "successCriteria" TEXT NOT NULL DEFAULT '',
    "failureCriteria" TEXT NOT NULL DEFAULT '',
    "deadlineAt" TIMESTAMP(3),
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureReason" TEXT,
    "correlationId" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "resumePoint" TEXT,
    "lastError" TEXT,
    "failureClass" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentMission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoopTransition" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" TEXT NOT NULL,
    "toStage" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '',
    "evidenceType" TEXT NOT NULL DEFAULT 'VERIFIED_DATA',
    "correlationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoopTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "opportunityId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'SIMULATION',
    "traffic" INTEGER NOT NULL DEFAULT 0,
    "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenueUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costsUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "profitUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL DEFAULT 'SIMULATED',
    "stages" TEXT NOT NULL DEFAULT '[]',
    "decision" TEXT,
    "realTransaction" BOOLEAN NOT NULL DEFAULT false,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalMemory" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "opportunityId" TEXT,
    "observation" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT '',
    "applicability" TEXT NOT NULL DEFAULT '',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailureRecord" (
    "id" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT NOT NULL,
    "recoveryState" TEXT NOT NULL DEFAULT 'OPEN',
    "deadLettered" BOOLEAN NOT NULL DEFAULT false,
    "resumePoint" TEXT,
    "correlationId" TEXT NOT NULL,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "opportunityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FailureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentMission_correlationId_key" ON "AgentMission"("correlationId");

-- CreateIndex
CREATE INDEX "AgentMission_status_idx" ON "AgentMission"("status");

-- CreateIndex
CREATE INDEX "AgentMission_opportunityId_createdAt_idx" ON "AgentMission"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMission_agentType_createdAt_idx" ON "AgentMission"("agentType", "createdAt");

-- CreateIndex
CREATE INDEX "LoopTransition_opportunityId_createdAt_idx" ON "LoopTransition"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "LoopTransition_correlationId_idx" ON "LoopTransition"("correlationId");

-- CreateIndex
CREATE INDEX "SimulationRun_opportunityId_createdAt_idx" ON "SimulationRun"("opportunityId", "createdAt");

-- CreateIndex
CREATE INDEX "SimulationRun_correlationId_idx" ON "SimulationRun"("correlationId");

-- CreateIndex
CREATE INDEX "OperationalMemory_category_createdAt_idx" ON "OperationalMemory"("category", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalMemory_relatedEntityType_relatedEntityId_idx" ON "OperationalMemory"("relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE INDEX "OperationalMemory_opportunityId_idx" ON "OperationalMemory"("opportunityId");

-- CreateIndex
CREATE INDEX "FailureRecord_classification_createdAt_idx" ON "FailureRecord"("classification", "createdAt");

-- CreateIndex
CREATE INDEX "FailureRecord_correlationId_idx" ON "FailureRecord"("correlationId");

-- CreateIndex
CREATE INDEX "FailureRecord_recoveryState_idx" ON "FailureRecord"("recoveryState");

-- AddForeignKey
ALTER TABLE "AgentMission" ADD CONSTRAINT "AgentMission_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoopTransition" ADD CONSTRAINT "LoopTransition_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationRun" ADD CONSTRAINT "SimulationRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalMemory" ADD CONSTRAINT "OperationalMemory_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FailureRecord" ADD CONSTRAINT "FailureRecord_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
