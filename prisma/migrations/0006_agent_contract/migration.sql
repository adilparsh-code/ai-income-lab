-- Agent Integration Contract v1 — external AI Agent boundary (additive only).
-- One append-only audit + idempotency row per externally-submitted agent
-- action. The unique `requestId` is the duplicate-request guard: a replayed
-- request collides here and returns the stored response, never a second job,
-- revenue row, experiment, product, payment, or config change. Execution
-- authority stays with the EXISTING Job Runner; this table never executes and
-- never bypasses halal, budget, or human-review gates. The credential itself
-- is NEVER stored — only a keyed HMAC fingerprint (agentFingerprint).

-- CreateTable
CREATE TABLE "AgentActionRecord" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "authorizationResult" TEXT NOT NULL,
    "safetyVerdict" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "jobId" TEXT,
    "reviewId" TEXT,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "reason" TEXT NOT NULL DEFAULT '',
    "agentFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentActionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentActionRecord_requestId_key" ON "AgentActionRecord"("requestId");

-- CreateIndex
CREATE INDEX "AgentActionRecord_agentId_createdAt_idx" ON "AgentActionRecord"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentActionRecord_correlationId_idx" ON "AgentActionRecord"("correlationId");

-- CreateIndex
CREATE INDEX "AgentActionRecord_status_createdAt_idx" ON "AgentActionRecord"("status", "createdAt");
