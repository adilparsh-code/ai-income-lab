-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "businessModel" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "problemSolved" TEXT NOT NULL,
    "monetizationMethod" TEXT NOT NULL,
    "estimatedStartupCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "demandScore" INTEGER NOT NULL DEFAULT 0,
    "competitionScore" INTEGER NOT NULL DEFAULT 0,
    "commercialIntentScore" INTEGER NOT NULL DEFAULT 0,
    "automationScore" INTEGER NOT NULL DEFAULT 0,
    "differentiationScore" INTEGER NOT NULL DEFAULT 0,
    "monetizationScore" INTEGER NOT NULL DEFAULT 0,
    "halalConfidenceScore" INTEGER NOT NULL DEFAULT 100,
    "overallScore" INTEGER NOT NULL DEFAULT 0,
    "halalStatus" TEXT NOT NULL DEFAULT 'HALAL',
    "confidenceLevel" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'IDEA',
    "evidenceNotes" TEXT NOT NULL DEFAULT '',
    "risks" TEXT NOT NULL DEFAULT '',
    "nextAction" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastReviewedAt" TIMESTAMP(3),

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'IDEA',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "platform" TEXT NOT NULL DEFAULT '',
    "productUrl" TEXT NOT NULL DEFAULT '',
    "affiliateUrl" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "opportunityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "solution" TEXT NOT NULL DEFAULT '',
    "userFlows" TEXT NOT NULL DEFAULT '[]',
    "techRequirements" TEXT NOT NULL DEFAULT '[]',
    "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]',
    "lifecycleHistory" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBuild" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" TEXT,
    "artifactRef" TEXT,
    "tests" TEXT NOT NULL DEFAULT '{}',
    "logSummary" TEXT NOT NULL DEFAULT '',
    "qualityGates" TEXT NOT NULL DEFAULT '[]',
    "sandboxed" BOOLEAN NOT NULL DEFAULT true,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBuild_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDeployment" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "deploymentId" TEXT,
    "url" TEXT,
    "version" TEXT,
    "errors" TEXT NOT NULL DEFAULT '[]',
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvalTokenHash" TEXT NOT NULL DEFAULT '',
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAsset" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "rightsStatus" TEXT NOT NULL,
    "publicationStatus" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "budget" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "expectedResult" TEXT NOT NULL DEFAULT '',
    "actualResult" TEXT NOT NULL DEFAULT '',
    "visitors" INTEGER NOT NULL DEFAULT 0,
    "leads" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "sales" INTEGER NOT NULL DEFAULT 0,
    "revenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "profit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conversionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decision" TEXT,
    "opportunityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revenue" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "revenueSource" TEXT NOT NULL,
    "grossRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fees" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "advertisingCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otherCosts" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netRevenue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "referenceNote" TEXT NOT NULL DEFAULT '',
    "productId" TEXT,
    "opportunityId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Revenue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Affiliate" (
    "id" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "affiliateProgram" TEXT NOT NULL DEFAULT '',
    "commissionType" TEXT NOT NULL DEFAULT '',
    "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "affiliateUrl" TEXT NOT NULL DEFAULT '',
    "productUrl" TEXT NOT NULL DEFAULT '',
    "lastChecked" TIMESTAMP(3),
    "linkStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "disclosureStatus" TEXT NOT NULL DEFAULT 'REQUIRED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Affiliate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Content" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "seoTitle" TEXT NOT NULL DEFAULT '',
    "metaDescription" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "opportunityId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItemModel" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL DEFAULT 'WEB_PAGE',
    "evidenceType" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "excerpt" TEXT NOT NULL DEFAULT '',
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "contentLength" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "retrievedVia" TEXT NOT NULL DEFAULT 'direct_fetch',
    "fetchDurationMs" INTEGER,
    "cache" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvidenceItemModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT,
    "objective" TEXT NOT NULL,
    "currentStage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "aiInputTokens" INTEGER,
    "aiOutputTokens" INTEGER,
    "estimatedCostUsd" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "id" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationAuthorization" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "scope" TEXT,
    "state" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "expiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT NOT NULL DEFAULT '[]',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "opportunityId" TEXT,
    "agentType" TEXT,
    "input" TEXT NOT NULL DEFAULT '{}',
    "resultRef" TEXT,
    "output" TEXT,
    "error" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "executionMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "workflowType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "plan" TEXT NOT NULL DEFAULT '{}',
    "steps" TEXT NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "campaignId" TEXT,
    "opportunityId" TEXT,
    "experimentId" TEXT,
    "sessionId" TEXT,
    "amountUsd" DOUBLE PRECISION,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "referrer" TEXT,
    "landingPage" TEXT,
    "source" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL DEFAULT 'VERIFIED_DATA',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentLog" (
    "id" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "input" TEXT NOT NULL DEFAULT '',
    "output" TEXT NOT NULL DEFAULT '',
    "reasoning" TEXT NOT NULL DEFAULT '',
    "evidenceType" TEXT NOT NULL DEFAULT 'AI_INFERENCE',
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCostUsd" DOUBLE PRECISION,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "purpose" TEXT,
    "latencyMs" INTEGER,
    "success" BOOLEAN,
    "productId" TEXT,
    "opportunityId" TEXT,
    "experimentId" TEXT,
    "jobId" TEXT,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductBuild_productId_createdAt_idx" ON "ProductBuild"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductDeployment_productId_createdAt_idx" ON "ProductDeployment"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "ProductAsset_productId_createdAt_idx" ON "ProductAsset"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Revenue_idempotencyKey_key" ON "Revenue"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EvidenceItemModel_opportunityId_idx" ON "EvidenceItemModel"("opportunityId");

-- CreateIndex
CREATE INDEX "EvidenceItemModel_fetchedAt_idx" ON "EvidenceItemModel"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceItemModel_url_query_key" ON "EvidenceItemModel"("url", "query");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_createdAt_idx" ON "SecurityEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_surface_createdAt_idx" ON "SecurityEvent"("surface", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitWindow_expiresAt_idx" ON "RateLimitWindow"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitWindow_bucketKey_windowKey_key" ON "RateLimitWindow"("bucketKey", "windowKey");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAuthorization_providerId_scope_key" ON "IntegrationAuthorization"("providerId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_status_idx" ON "JobRun"("status");

-- CreateIndex
CREATE INDEX "JobRun_jobType_createdAt_idx" ON "JobRun"("jobType", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_correlationId_idx" ON "JobRun"("correlationId");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowType_createdAt_idx" ON "WorkflowRun"("workflowType", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_correlationId_idx" ON "WorkflowRun"("correlationId");

-- CreateIndex
CREATE INDEX "WorkflowRun_status_idx" ON "WorkflowRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEvent_idempotencyKey_key" ON "ProductEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProductEvent_productId_utmCampaign_idx" ON "ProductEvent"("productId", "utmCampaign");

-- CreateIndex
CREATE INDEX "ProductEvent_productId_occurredAt_idx" ON "ProductEvent"("productId", "occurredAt");

-- CreateIndex
CREATE INDEX "ProductEvent_productId_eventType_idx" ON "ProductEvent"("productId", "eventType");

-- CreateIndex
CREATE INDEX "AgentLog_agentType_createdAt_idx" ON "AgentLog"("agentType", "createdAt");

-- CreateIndex
CREATE INDEX "AgentLog_createdAt_idx" ON "AgentLog"("createdAt");

-- CreateIndex
CREATE INDEX "AgentLog_productId_idx" ON "AgentLog"("productId");

-- CreateIndex
CREATE INDEX "AgentLog_opportunityId_idx" ON "AgentLog"("opportunityId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBuild" ADD CONSTRAINT "ProductBuild_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDeployment" ADD CONSTRAINT "ProductDeployment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAsset" ADD CONSTRAINT "ProductAsset_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revenue" ADD CONSTRAINT "Revenue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revenue" ADD CONSTRAINT "Revenue_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItemModel" ADD CONSTRAINT "EvidenceItemModel_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

