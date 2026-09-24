// Phase 8 — shared types for the autonomous operations layer.
// Pure module: no DB, no network, no secrets.

export const MISSION_STATUSES = [
  'QUEUED',
  'READY',
  'RUNNING',
  'WAITING',
  'HUMAN_REVIEW',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export function isMissionStatus(value: unknown): value is MissionStatus {
  return typeof value === 'string' && (MISSION_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = [
  'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'HUMAN_REVIEW',
];

export const AUTONOMOUS_STAGES = [
  'DISCOVER',
  'RESEARCH',
  'VALIDATE',
  'DECIDE',
  'BUILD',
  'TEST',
  'DEPLOY',
  'PUBLISH',
  'TRAFFIC',
  'CONVERT',
  'REVENUE',
  'LEARN',
  'ITERATE',
] as const;
export type AutonomousStage = (typeof AUTONOMOUS_STAGES)[number];

export const LIFECYCLE_DECISIONS = [
  'CONTINUE',
  'ITERATE',
  'PAUSE',
  'KILL',
  'SCALE',
  'HUMAN_REVIEW',
] as const;
export type LifecycleDecision = (typeof LIFECYCLE_DECISIONS)[number];

export const FAILURE_CLASSES = [
  'TRANSIENT',
  'PERMANENT',
  'CONFIGURATION',
  'AUTHENTICATION',
  'PROVIDER_UNAVAILABLE',
  'VALIDATION',
  'BUSINESS_RULE',
  'HUMAN_REVIEW',
  'TIMEOUT',
  'UNKNOWN',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const EVIDENCE_CLASSES = [
  'AI_INFERENCE',
  'SEARCH_DISCOVERY',
  'VERIFIED_DATA',
  'HUMAN_DECISION',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const SYSTEM_STATE_LABELS = [
  'LIVE',
  'MOCKED',
  'SIMULATED',
  'NOT_CONFIGURED',
  'NOT_CONNECTED',
  'BLOCKED',
  'AWAITING_HUMAN_INPUT',
] as const;
export type SystemStateLabel = (typeof SYSTEM_STATE_LABELS)[number];

export const MEMORY_OPS_CATEGORIES = [
  'opportunity',
  'product',
  'experiment',
  'failure',
  'market',
  'agent',
  'provider',
] as const;
export type OpsMemoryCategory = (typeof MEMORY_OPS_CATEGORIES)[number];

export const ALLOWED_MISSION_CAPABILITIES = [
  'RESEARCH',
  'VALIDATION',
  'PRODUCT',
  'ANALYTICS',
  'BUSINESS_MANAGER',
  'PRODUCT_CREATE',
  'PRODUCT_BUILD',
  'PRODUCT_TEST',
  'PRODUCT_DEPLOY',
  'PRODUCT_PUBLISH',
  'REVENUE_SYNC',
  'PRODUCT_ANALYZE',
] as const;
export type MissionCapability = (typeof ALLOWED_MISSION_CAPABILITIES)[number];

export function isMissionCapability(value: unknown): value is MissionCapability {
  return typeof value === 'string' && (ALLOWED_MISSION_CAPABILITIES as readonly string[]).includes(value);
}

export const FORBIDDEN_MISSION_CAPABILITIES = [
  'SHELL',
  'ARBITRARY_EXEC',
  'ENV_INJECT',
  'SECRET_READ',
  'BYPASS_HALAL',
  'BYPASS_HUMAN_REVIEW',
  'FABRICATE_REVENUE',
  'FABRICATE_TRAFFIC',
  'UNAUTHORISED_PUBLISH',
  'UNAUTHORISED_DEPLOY',
] as const;

export function evidenceRank(evidence: EvidenceClass): number {
  switch (evidence) {
    case 'VERIFIED_DATA':
      return 4;
    case 'HUMAN_DECISION':
      return 3;
    case 'SEARCH_DISCOVERY':
      return 2;
    case 'AI_INFERENCE':
      return 1;
  }
}

export interface MissionSpec {
  objective: string;
  opportunityId?: string;
  agentType: string;
  constraints?: string[];
  budgetUsd?: number;
  allowedCapabilities?: MissionCapability[];
  expectedOutput?: string;
  successCriteria?: string;
  failureCriteria?: string;
  deadlineAt?: string;
  timeoutMs?: number;
  approvalRequired?: boolean;
  correlationId: string;
}

export interface MissionRecord {
  id: string;
  objective: string;
  opportunityId: string | null;
  agentType: string;
  constraints: string[];
  budgetUsd: number;
  allowedCapabilities: MissionCapability[];
  expectedOutput: string;
  successCriteria: string;
  failureCriteria: string;
  deadlineAt: string | null;
  timeoutMs: number;
  approvalRequired: boolean;
  status: MissionStatus;
  failureReason: string | null;
  correlationId: string;
  retryCount: number;
  resumePoint: string | null;
  lastError: string | null;
  failureClass: FailureClass | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LoopTransitionRecord {
  from: AutonomousStage;
  to: AutonomousStage;
  reason: string;
  evidence: string;
  evidenceType: EvidenceClass;
  correlationId: string;
  timestamp: string;
  status: string;
}

export const MAX_MISSION_OBJECTIVE = 4000;
export const MAX_MISSION_CONSTRAINTS = 16;
export const MAX_CONSTRAINT_LENGTH = 300;
export const MAX_CORRELATION_ID = 200;
export const DEFAULT_MISSION_TIMEOUT_MS = 120_000;
export const MAX_MISSION_TIMEOUT_MS = 600_000;
export const MAX_MISSION_BUDGET_USD = 50;
export const DEFAULT_FAILURE_MAX_RETRIES = 3;
export const MAX_FAILURE_RETRIES = 5;
