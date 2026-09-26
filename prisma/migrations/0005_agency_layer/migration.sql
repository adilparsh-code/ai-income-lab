-- CreateTable
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "tokenFingerprint" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentDefinition" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mission" TEXT NOT NULL,
    "allowedTools" TEXT NOT NULL DEFAULT '[]',
    "allowedStages" TEXT NOT NULL DEFAULT '[]',
    "forbiddenActions" TEXT NOT NULL DEFAULT '[]',
    "budgetLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "stopConditions" TEXT NOT NULL DEFAULT '[]',
    "evidenceRequirement" TEXT NOT NULL DEFAULT 'AI_INFERENCE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "jobId" TEXT,
    "jobType" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "lifecycleSteps" TEXT NOT NULL DEFAULT '[]',
    "safetyVerdict" TEXT,
    "verification" TEXT,
    "failureReason" TEXT,
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "jobId" TEXT,
    "sourceAgent" TEXT NOT NULL,
    "targetAgent" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHealth" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reasons" TEXT NOT NULL DEFAULT '[]',
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPermission" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'ALLOW',
    "scope" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanReview" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "opportunityId" TEXT,
    "evidenceRefs" TEXT NOT NULL DEFAULT '[]',
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupervisorEvaluation" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT,
    "correlationId" TEXT NOT NULL,
    "planValid" BOOLEAN NOT NULL,
    "outputValid" BOOLEAN NOT NULL,
    "loopDetected" BOOLEAN NOT NULL DEFAULT false,
    "loopReason" TEXT,
    "budgetViolation" BOOLEAN NOT NULL DEFAULT false,
    "safetyViolation" BOOLEAN NOT NULL DEFAULT false,
    "verdict" TEXT NOT NULL,
    "reasons" TEXT NOT NULL DEFAULT '[]',
    "harnessStatus" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyControl" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pauseReason" TEXT,
    "pausedBy" TEXT,
    "pausedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenFingerprint_key" ON "AdminSession"("tokenFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDefinition_agentId_key" ON "AgentDefinition"("agentId");

-- CreateIndex
CREATE INDEX "AgentRun_agentId_startedAt_idx" ON "AgentRun"("agentId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_correlationId_idx" ON "AgentRun"("correlationId");

-- CreateIndex
CREATE INDEX "AgentRun_jobId_idx" ON "AgentRun"("jobId");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE INDEX "AgentMessage_correlationId_idx" ON "AgentMessage"("correlationId");

-- CreateIndex
CREATE INDEX "AgentMessage_targetAgent_createdAt_idx" ON "AgentMessage"("targetAgent", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMessage_sourceAgent_createdAt_idx" ON "AgentMessage"("sourceAgent", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHealth_agentId_key" ON "AgentHealth"("agentId");

-- CreateIndex
CREATE INDEX "AgentHealth_state_idx" ON "AgentHealth"("state");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPermission_agentId_tool_key" ON "AgentPermission"("agentId", "tool");

-- CreateIndex
CREATE INDEX "HumanReview_status_createdAt_idx" ON "HumanReview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HumanReview_category_idx" ON "HumanReview"("category");

-- CreateIndex
CREATE INDEX "SupervisorEvaluation_correlationId_idx" ON "SupervisorEvaluation"("correlationId");

-- CreateIndex
CREATE INDEX "SupervisorEvaluation_verdict_evaluatedAt_idx" ON "SupervisorEvaluation"("verdict", "evaluatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyControl_key_key" ON "AgencyControl"("key");

