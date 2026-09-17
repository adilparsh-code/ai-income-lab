// Agent type definitions for AI Income Lab Phase 3.1

export type AgentType = 
  | 'research'
  | 'validation' 
  | 'product'
  | 'analytics'
  | 'business-manager';

export type AgentStatus = 'LIVE' | 'MOCKED' | 'PLANNED';

// SEARCH_DISCOVERY marks search-provider metadata (title/snippet/url) that was
// never fetched. It can NEVER be promoted to VERIFIED_DATA by AI output; only
// content actually fetched from the origin and validated is VERIFIED_DATA.
export type EvidenceType = 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED' | 'SEARCH_DISCOVERY';

export type AgentExecutionStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface Agent {
  id: string;
  type: AgentType;
  name: string;
  description: string;
  purpose: string;
  currentCapability: string;
  status: AgentStatus;
  evidencePolicy: string;
  safeExecutionState: boolean;
  icon: string;
}

export interface AgentRequest {
  agentType: AgentType;
  action: string;
  input: Record<string, unknown>;
  opportunityId?: string;
}

export interface AgentResult {
  success: boolean;
  output: unknown;
  reasoning: string;
  evidenceType: EvidenceType;
  error?: string;
  executionTime: number;
  // Phase 4.2.1: optional AI provider metadata. Absent for deterministic/mock
  // executions. Provider output is always classified as AI_INFERENCE — this
  // metadata can never promote output to VERIFIED_DATA.
  capabilityStatus?: AgentStatus;
  fallbackUsed?: boolean;
  aiUsage?: AiUsageMetadata;
}

// Phase 4.2.1: token/cost attribution for a single real-AI provider call.
// All costs are estimates from an isolated price table (see src/lib/ai/models.ts)
// and must never be presented as verified billing data.
export interface AiUsageMetadata {
  provider: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

// Research Agent specific types
export interface ResearchRequest {
  opportunityId?: string;
  researchObjective: string;
  targetAudience?: string;
  marketCategory?: string;
  geography?: string;
  constraints?: string[];
  halalRequirements?: string[];
}

export interface ResearchFinding {
  id: string;
  content: string;
  evidenceType: EvidenceType;
}

export interface ResearchSignal {
  id: string;
  type: 'demand' | 'risk' | 'monetization' | 'competitor';
  content: string;
  confidence: number;
  evidenceType: EvidenceType;
  isMocked: boolean;
}

// Real Research Engine (Phase 5.1): external evidence with strict provenance.
export type ResearchSourceType = 'SEARCH_DISCOVERY' | 'VERIFIED_DATA';

export interface ResearchSourceRef {
  url: string;
  domain: string;
  title: string;
  /** Search-result snippet (SEARCH_DISCOVERY only; never fetched). */
  snippet?: string;
  /** Extracted page text (VERIFIED_DATA only; actually fetched). */
  excerpt?: string;
  evidenceType: ResearchSourceType;
  /** ISO 8601 retrieval/fetch timestamp. */
  retrievedAt: string;
  /** Fetch metadata — present only for VERIFIED_DATA. */
  httpStatus?: number;
  contentType?: string;
  contentLength?: number;
  fetchDurationMs?: number;
}

export interface ResearchSourceReport {
  status: 'OK' | 'PARTIAL' | 'NOT_CONFIGURED' | 'BLOCKED' | 'FAILED' | 'OFFLINE';
  searchProviderId: string | null;
  /** 'live' = network fetches this run; 'cache' = previously fetched evidence. */
  servedFrom: 'live' | 'cache' | 'none';
  discoveryCount: number;
  verifiedCount: number;
  fetchErrors: string[];
  reasoning: string;
  ranAt: string;
}

export interface ResearchResult {
  researchObjective: string;
  findings: ResearchFinding[];
  signals: ResearchSignal[];
  assumptions: string[];
  risks: string[];
  competitors: string[];
  demandIndicators: string[];
  monetizationObservations: string[];
  halalConsiderations: string[];
  overallConfidence: number;
  evidenceItems: { id: string; type: EvidenceType; content: string }[];
  /** External sources considered by the Real Research Engine (may be empty). */
  sources: ResearchSourceRef[];
  /** Real-research pass report; null when the engine did not run (mock mode). */
  sourceResearch: ResearchSourceReport | null;
  capabilityStatus: AgentStatus;
  agentLogId?: string;
}

// Validation Agent specific types
export type ValidationMethod = 
  | 'LANDING_PAGE'
  | 'SURVEY'
  | 'INTERVIEW'
  | 'PREORDER'
  | 'CONTENT_TEST'
  | 'PRICE_TEST'
  | 'EXPERIMENT'
  | 'MANUAL_RESEARCH';

export type ValidationDecision =
  | 'PROMISING'
  | 'NEEDS_VALIDATION'
  | 'WEAK_SIGNAL'
  | 'BLOCKED';

export interface ValidationRequest {
  opportunityId?: string;
  validationObjective: string;
  targetAudience?: string;
  keyAssumptions?: string[];
  validationConstraints?: string[];
  preferredValidationMethod?: ValidationMethod;
  halalRequirements?: string[];
}

export interface ValidationTest {
  id: string;
  name: string;
  method: ValidationMethod;
  description: string;
  estimatedEffort: 'LOW' | 'MEDIUM' | 'HIGH';
  priority: number;
}

export interface ExperimentRecommendation {
  id: string;
  experimentName: string;
  hypothesis: string;
  method: ValidationMethod;
  metric: string;
  successThreshold: number;
  failureThreshold: number;
  estimatedEffort: 'LOW' | 'MEDIUM' | 'HIGH';
  priority: number;
  evidenceNeeded: string[];
}

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  content: string;
  source?: string;
}

export interface ValidationResult {
  opportunityContext?: {
    id: string;
    title: string;
    problemSolved?: string;
    overallScore?: number;
  };
  validationObjective: string;
  assumptions: string[];
  prioritizedRisks: { id: string; risk: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; likelihood: number }[];
  validationTests: ValidationTest[];
  experimentRecommendations: ExperimentRecommendation[];
  successCriteria: string[];
  failureCriteria: string[];
  evidenceRequirements: string[];
  currentEvidence: EvidenceItem[];
  confidence: number;
  halalStatus: string;
  humanReviewRequired: boolean;
  recommendation: ValidationDecision;
  capabilityStatus: AgentStatus;
  agentLogId?: string;
}

// Product Agent specific types
export type ProductType =
  | 'DIGITAL_PRODUCT'
  | 'SAAS'
  | 'WEB_APP'
  | 'MOBILE_APP'
  | 'TEMPLATE'
  | 'PRINTABLE'
  | 'COURSE'
  | 'TOOL'
  | 'SERVICE_PRODUCT';

export type MonetizationModel =
  | 'ONE_TIME_PURCHASE'
  | 'SUBSCRIPTION'
  | 'FREEMIUM'
  | 'SERVICE'
  | 'LICENSE'
  | 'AFFILIATE'
  | 'AD_SUPPORTED';

export interface ProductRequest {
  opportunityId?: string;
  productObjective: string;
  productType: ProductType;
  targetAudience?: string;
  customerProblem?: string;
  preferredPlatform?: string;
  constraints?: string[];
  budgetConstraints?: string;
  monetizationPreference?: MonetizationModel;
  halalRequirements?: string[];
}

export interface ProductConcept {
  productNameHypothesis: string;
  oneLineDescription: string;
  customer: string;
  problem: string;
  proposedSolution: string;
  coreValueProposition: string;
  differentiationHypothesis: string;
  productFormat: string;
  primaryUseCase: string;
  evidenceType: EvidenceType;
}

export interface MVPFeature {
  id: string;
  name: string;
  description: string;
  priority: 'ESSENTIAL' | 'IMPORTANT' | 'DEFERRED';
}

export interface BuildPhase {
  phase: number;
  name: string;
  tasks: string[];
  dependencies: string[];
  expectedOutput: string;
  risk: string;
}

export interface ProductResult {
  opportunityContext?: {
    id: string;
    title: string;
    problemSolved?: string;
    overallScore?: number;
  };
  productConcept: ProductConcept;
  productType: ProductType;
  targetCustomer: string;
  problemBeingSolved: string;
  valueProposition: string;
  mvpFeatures: MVPFeature[];
  optionalFutureFeatures: string[];
  userWorkflow: string[];
  productRequirements: string[];
  technicalRequirements: string[];
  buildPhases: BuildPhase[];
  monetizationModel: MonetizationModel | string;
  monetizationRationale: string;
  pricingHypothesis: string;
  monetizationAssumptions: string[];
  monetizationRisks: string[];
  evidenceNeeded: string[];
  distributionChannels: string[];
  contentStrategy: string;
  landingPageConcept: string;
  conversionPath: string[];
  risks: string[];
  assumptions: string[];
  evidence: EvidenceItem[];
  researchContext: string;
  validationContext: string;
  confidence: number;
  halalStatus: string;
  humanReviewRequired: boolean;
  recommendation: string;
  capabilityStatus: AgentStatus;
  agentLogId?: string;
}

// Analytics Agent specific types
export type AnalyticsScope =
  | 'OVERVIEW'
  | 'EXPERIMENTS'
  | 'PRODUCTS'
  | 'REVENUE'
  | 'OPPORTUNITIES'
  | 'FULL_BUSINESS';

export interface AnalyticsRequest {
  opportunityId?: string;
  productId?: string;
  experimentId?: string;
  startDate?: string;
  endDate?: string;
  analysisObjective: string;
  analysisScope: AnalyticsScope;
}

export interface KpiMetric {
  id: string;
  label: string;
  value: string;
  evidenceType: EvidenceType;
  isCalculated: boolean;
  unit?: string;
}

export interface TrendItem {
  id: string;
  label: string;
  direction: 'INCREASING' | 'DECREASING' | 'STABLE';
  description: string;
  evidenceType: EvidenceType;
  dataPoints?: number;
}

export interface AnomalyItem {
  id: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  description: string;
  evidenceType: EvidenceType;
}

export interface NextBestActionItem {
  id: string;
  action: string;
  reason: string;
  priority: number;
  evidenceType: EvidenceType;
}

export interface ExperimentInsight {
  id: string;
  label: string;
  description: string;
  evidenceType: EvidenceType;
}

export interface ProductInsight {
  id: string;
  label: string;
  description: string;
  evidenceType: EvidenceType;
}

export interface RevenueInsight {
  id: string;
  label: string;
  description: string;
  evidenceType: EvidenceType;
}

export interface OpportunityInsight {
  id: string;
  label: string;
  description: string;
  evidenceType: EvidenceType;
}

export interface DataAvailability {
  opportunities: number;
  experiments: number;
  products: number;
  revenues: number;
  insufficientDataWarnings: string[];
}

export interface AnalyticsResult {
  analysisScope: AnalyticsScope;
  period: {
    startDate?: string;
    endDate?: string;
    label: string;
  };
  dataSummary: DataAvailability;
  kpiMetrics: KpiMetric[];
  experimentInsights: ExperimentInsight[];
  productInsights: ProductInsight[];
  revenueInsights: RevenueInsight[];
  opportunityInsights: OpportunityInsight[];
  trends: TrendItem[];
  anomalies: AnomalyItem[];
  risks: string[];
  assumptions: string[];
  recommendations: string[];
  nextBestActions: NextBestActionItem[];
  evidence: EvidenceItem[];
  /**
   * Deterministic Business Intelligence / profitability analysis (VERIFIED_DATA).
   * Computed by the shared src/lib/business layer; AI never alters these numbers.
   */
  businessIntelligence?: import('@/lib/business/profitability').BusinessIntelligenceResult;
  confidence: number;
  halalStatus: string;
  humanReviewRequired: boolean;
  recommendation: string;
  capabilityStatus: AgentStatus;
  agentLogId?: string;
}

// Business Manager Agent specific types
export type BusinessManagerScope =
  | 'OPPORTUNITY_SELECTION'
  | 'VALIDATION_DECISION'
  | 'PRODUCT_DECISION'
  | 'EXPERIMENT_DECISION'
  | 'REVENUE_IMPROVEMENT'
  | 'FULL_BUSINESS_REVIEW';

export type ActionType =
  | 'RESEARCH'
  | 'VALIDATE'
  | 'BUILD_PRODUCT'
  | 'RUN_EXPERIMENT'
  | 'ANALYZE'
  | 'IMPROVE_PRODUCT'
  | 'REVIEW_REVENUE'
  | 'COLLECT_DATA'
  | 'HUMAN_REVIEW'
  | 'NO_ACTION';

export type DecisionState =
  | 'PROCEED'
  | 'VALIDATE_FIRST'
  | 'IMPROVE'
  | 'COLLECT_MORE_DATA'
  | 'HUMAN_REVIEW'
  | 'BLOCKED'
  | 'NO_ACTION';

export interface NextBestAction {
  action: ActionType;
  reason: string;
  evidence: string;
  evidenceType: EvidenceType;
  priority: number;
  expectedPurpose: string;
  blockers: string[];
  humanApprovalRequired: boolean;
  executionEligible: boolean;
}

export interface BusinessManagerRequest {
  opportunityId?: string;
  productId?: string;
  experimentId?: string;
  objective: string;
  decisionScope: BusinessManagerScope;
  riskTolerance?: 'LOW' | 'MEDIUM' | 'HIGH';
  preferredActionType?: ActionType;
  halalRequirements?: string[];
}

export interface BusinessManagerResult {
  decision: DecisionState;
  decisionRationale: string;
  nextBestAction: NextBestAction;
  alternativeActionsConsidered: { action: ActionType; reasonRejected: string; evidenceType: EvidenceType }[];
  confidence: number;
  opportunityContext?: {
    id: string;
    title: string;
    overallScore?: number;
    status: string;
    halalStatus: string;
  };
  researchSummary: string;
  researchEvidenceType: EvidenceType;
  validationSummary: string;
  validationEvidenceType: EvidenceType;
  productSummary: string;
  productEvidenceType: EvidenceType;
  analyticsSummary: string;
  analyticsEvidenceType: EvidenceType;
  /**
   * Verified profitability summary for the selected scope (deterministic
   * business-intelligence layer). AI_INFERENCE only when no revenue data
   * exists to analyze.
   */
  profitabilitySummary: string;
  profitabilityEvidenceType: EvidenceType;
  evidence: EvidenceItem[];
  assumptions: string[];
  risks: string[];
  blockers: string[];
  missingInformation: string[];
  halalStatus: string;
  humanReviewRequired: boolean;
  executionEligible: boolean;
  recommendation: string;
  capabilityStatus: AgentStatus;
  agentLogId?: string;
}

export interface AgentLogEntry {
  id: string;
  agentType: string;
  action: string;
  input: string;
  output: string;
  reasoning: string;
  evidenceType: string;
  createdAt: Date;
}