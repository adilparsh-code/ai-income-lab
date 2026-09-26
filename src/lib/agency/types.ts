// ============================================================================
// AGENCY — SUPERVISOR TYPES (Phases 2–12 shared vocabulary)
// ============================================================================
// Pure module: no DB, no network, no secrets. Mirrors the style of
// src/lib/jobs/types.ts and src/lib/ops/types.ts.
// ============================================================================

/** The 13-agent roster. agentId values are stable identifiers. */
export const AGENCY_AGENT_IDS = [
  'business-manager',
  'research',
  'validation',
  'safety-halal',
  'product',
  'publishing',
  'growth',
  'revenue',
  'analytics',
  'memory',
  'job-runner',
  'supervisor',
  'ruflo-adapter',
] as const;

export type AgencyAgentId = (typeof AGENCY_AGENT_IDS)[number];

export function isAgencyAgentId(value: unknown): value is AgencyAgentId {
  return typeof value === 'string' && (AGENCY_AGENT_IDS as readonly string[]).includes(value);
}

/** Runtime agent statuses shown in the control center — from real state only. */
export const AGENT_RUNTIME_STATUSES = [
  'OFFLINE', 'READY', 'RUNNING', 'WAITING', 'BLOCKED', 'FAILED', 'PAUSED', 'DEGRADED',
] as const;
export type AgentRuntimeStatus = (typeof AGENT_RUNTIME_STATUSES)[number];

/** Deterministic health states (no arbitrary scores). */
export const AGENT_HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'BLOCKED', 'FAILED', 'UNKNOWN'] as const;
export type AgentHealthState = (typeof AGENT_HEALTH_STATES)[number];

/** Workflow stages — extends the existing AUTONOMOUS_STAGES vocabulary. */
export const AGENCY_STAGES = [
  'DISCOVER', 'RESEARCH', 'VALIDATE', 'SAFETY', 'DECIDE', 'BUILD', 'PUBLISH',
  'TRAFFIC', 'CONVERT', 'REVENUE', 'ANALYZE', 'GROWTH', 'LEARN', 'LOOP',
] as const;
export type AgencyStage = (typeof AGENCY_STAGES)[number];

export function isAgencyStage(value: unknown): value is AgencyStage {
  return typeof value === 'string' && (AGENCY_STAGES as readonly string[]).includes(value);
}

/** Universal agent lifecycle steps enforced by the supervised runner. */
export const LIFECYCLE_STEPS = [
  'PLAN', 'VALIDATE_INPUT', 'SAFETY_CHECK', 'EXECUTE',
  'VERIFY_OUTPUT', 'PERSIST_RESULT', 'UPDATE_MEMORY', 'REPORT',
] as const;
export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

/** Message kinds for allow-listed directional communication. */
export const AGENT_MESSAGE_KINDS = ['TASK_REQUEST', 'RESULT', 'FINDING', 'ESCALATION', 'DECISION'] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return typeof value === 'string' && (AGENT_MESSAGE_KINDS as readonly string[]).includes(value);
}

/** Supervisor verdicts. */
export const SUPERVISOR_VERDICTS = ['PROCEED', 'QUARANTINE', 'PAUSE', 'ESCALATE'] as const;
export type SupervisorVerdict = (typeof SUPERVISOR_VERDICTS)[number];

/** Harness boundary states — never faked. */
export const HARNESS_STATES = ['NOT_CONNECTED', 'CONNECTED', 'DEGRADED'] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

/** Human review categories. */
export const HUMAN_REVIEW_CATEGORIES = [
  'SAFETY_REVIEW', 'PUBLICATION', 'SPENDING', 'PAYMENT_CONFIG',
  'SECURITY_CHANGE', 'DESTRUCTIVE_DB', 'CREDENTIALS', 'IRREVERSIBLE',
] as const;
export type HumanReviewCategory = (typeof HUMAN_REVIEW_CATEGORIES)[number];

export const HUMAN_REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'RETIRED'] as const;
export type HumanReviewStatus = (typeof HUMAN_REVIEW_STATUSES)[number];

export function isHumanReviewCategory(value: unknown): value is HumanReviewCategory {
  return typeof value === 'string' && (HUMAN_REVIEW_CATEGORIES as readonly string[]).includes(value);
}

export function isHumanReviewStatus(value: unknown): value is HumanReviewStatus {
  return typeof value === 'string' && (HUMAN_REVIEW_STATUSES as readonly string[]).includes(value);
}

export const HUMAN_REVIEW_ACTIONS = ['APPROVE', 'REJECT', 'PAUSE', 'RETRY'] as const;
export type HumanReviewAction = (typeof HUMAN_REVIEW_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Loop protection reasons (Phase 11)
// ---------------------------------------------------------------------------

export const LOOP_DETECTORS = [
  'REPEATED_IDENTICAL_JOBS',
  'REPEATED_IDENTICAL_FAILURES',
  'RETRY_EXHAUSTION',
  'CIRCULAR_DELEGATION',
  'EXCESSIVE_TOKEN_USAGE',
  'EXCESSIVE_COST',
  'REPEATED_SAFETY_REJECTION',
  'STALE_WORKFLOW',
] as const;
export type LoopDetector = (typeof LOOP_DETECTORS)[number];

export type LoopFinding = {
  detector: LoopDetector;
  reason: string;
};

export type LoopEvaluation = {
  quarantined: boolean;
  findings: LoopFinding[];
};

// ---------------------------------------------------------------------------
// Health evaluation input (Phase 10) — deterministic inputs only
// ---------------------------------------------------------------------------

export type HealthEvaluationInput = {
  agentId: AgencyAgentId;
  recentRuns: {
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    safetyVerdict: string | null;
  }[];
  runningJobStartedAt: Date | null;
  timeoutThresholdMs: number;
  paused: boolean;
};

export type HealthEvaluation = {
  state: AgentHealthState;
  reasons: string[];
  successCount: number;
  failureCount: number;
  lastRunAt: Date | null;
};
