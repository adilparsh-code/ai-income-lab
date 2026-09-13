// Agent type definitions for AI Income Lab Phase 3.1

export type AgentType = 
  | 'research'
  | 'validation' 
  | 'product'
  | 'analytics'
  | 'business-manager';

export type AgentStatus = 'LIVE' | 'MOCKED' | 'PLANNED';

export type EvidenceType = 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED';

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