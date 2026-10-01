-- Phase 10A — Agent Control Center (additive only).
-- Runtime configuration as DATA, never source-code mutation. The dashboard
-- writes rows here; the Supervisor/Job Runner stay the only execution
-- authority. Rows in these tables hold NO execution authority and never
-- bypass halal gates, budget caps, AgentPermission allow-lists, human review
-- or audit. Historical AgentConfigVersion rows are immutable (append-only);
-- rollback creates a NEW version, never an update or delete of history.

-- CreateTable
CREATE TABLE "AgentControlState" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "desiredState" TEXT NOT NULL DEFAULT 'RUNNING',
    "derivedState" TEXT NOT NULL DEFAULT 'READY',
    "activeVersion" INTEGER,
    "pendingRestart" BOOLEAN NOT NULL DEFAULT false,
    "stopReason" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentControlState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentConfigVersion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configJson" TEXT NOT NULL,
    "changedFields" TEXT NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "changedBy" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentControlAction" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" TEXT,
    "newState" TEXT,
    "configVersion" INTEGER,
    "result" TEXT NOT NULL,
    "failureReason" TEXT,
    "changedBy" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentControlAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentControlState_agentId_key" ON "AgentControlState"("agentId");

-- CreateIndex
CREATE INDEX "AgentControlState_desiredState_idx" ON "AgentControlState"("desiredState");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConfigVersion_agentId_version_key" ON "AgentConfigVersion"("agentId", "version");

-- CreateIndex
CREATE INDEX "AgentConfigVersion_agentId_createdAt_idx" ON "AgentConfigVersion"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentControlAction_agentId_createdAt_idx" ON "AgentControlAction"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentControlAction_correlationId_idx" ON "AgentControlAction"("correlationId");

-- CreateIndex
CREATE INDEX "AgentControlAction_action_createdAt_idx" ON "AgentControlAction"("action", "createdAt");
