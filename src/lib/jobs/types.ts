// Phase 4.5.2 — Ruflo-ready job contract (types).
//
// This module is PURE: no DB, no network, no provider imports. It defines the
// job abstraction that the Job Runner executes and that a future external
// orchestrator (Ruflo) will drive through a narrow adapter boundary.
//
// Integration status: RUFLO_READY describes the *contract* only. The adapter
// is NOT_CONNECTED — no Ruflo package is installed and nothing here claims the
// system runs autonomously or in the background.

import type { AgentType } from '@/lib/agents/types';

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

/** Single-agent job types — mapped 1:1 onto existing AgentRegistry agents. */
export const AGENT_JOB_TYPES = ['RESEARCH', 'VALIDATION', 'PRODUCT', 'ANALYTICS', 'BUSINESS_MANAGER'] as const;

/** Orchestration job types — bounded multi-stage workflows over the pipeline. */
export const WORKFLOW_JOB_TYPES = ['OPPORTUNITY_PIPELINE'] as const;

export type AgentJobType = (typeof AGENT_JOB_TYPES)[number];
export type WorkflowJobType = (typeof WORKFLOW_JOB_TYPES)[number];
export type JobType = AgentJobType | WorkflowJobType;

export const ALL_JOB_TYPES: JobType[] = [...AGENT_JOB_TYPES, ...WORKFLOW_JOB_TYPES];

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && (ALL_JOB_TYPES as string[]).includes(value);
}

/** The existing AgentRegistry agent backing a single-agent job type. */
export const JOB_TYPE_TO_AGENT: Record<AgentJobType, AgentType> = {
  RESEARCH: 'research',
  VALIDATION: 'validation',
  PRODUCT: 'product',
  ANALYTICS: 'analytics',
  BUSINESS_MANAGER: 'business-manager',
};

// ---------------------------------------------------------------------------
// Job statuses (explicit; mirrors existing pipeline semantics)
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'HUMAN_REVIEW'
  | 'DEGRADED';

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'SUCCEEDED', 'FAILED', 'BLOCKED', 'HUMAN_REVIEW', 'DEGRADED',
];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (
    ['QUEUED', 'RUNNING', ...TERMINAL_JOB_STATUSES] as string[]
  ).includes(value);
}

// ---------------------------------------------------------------------------
// Execution mode + integration labels
// ---------------------------------------------------------------------------

/** How the job actually ran (mirrors AgentStatus LIVE/MOCKED semantics). */
export type JobExecutionMode = 'LIVE' | 'MOCKED';

/**
 * Ruflo integration boundary status. RUFLO_READY means the job contract and
 * runner exist and an adapter can drive them; it does NOT mean Ruflo is
 * connected, installed, or that anything runs autonomously.
 */
export type RufloIntegrationStatus = 'RUFLO_READY' | 'NOT_CONNECTED';

// ---------------------------------------------------------------------------
// Requests & outcomes
// ---------------------------------------------------------------------------

/** Minimal job payload contracts. Validation happens in job-definitions. */
export interface JobPayload {
  opportunityId?: string;
  [key: string]: unknown;
}

export interface JobRecord {
  id: string;
  jobType: JobType;
  status: JobStatus;
  correlationId: string;
  idempotencyKey: string;
  opportunityId: string | null;
  agentType: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  resultRef: Record<string, unknown> | null;
  error: string | null;
  retryCount: number;
  executionMode: JobExecutionMode | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** Deterministic result of running (or refusing to run) a job. */
export interface JobOutcome {
  jobId: string;
  jobType: JobType;
  status: JobStatus;
  /** True when the job had already run and was NOT re-executed. */
  deduplicated: boolean;
  /** AgentResult/PipelineRun summary for the caller (safe fields only). */
  result: Record<string, unknown> | null;
  error: string | null;
  executionMode: JobExecutionMode | null;
  retryCount: number;
}

/** Structural executor surface — the real implementation is the Job Runner. */
export interface JobExecutor {
  runJob(jobType: JobType, payload: JobPayload, correlationId?: string): Promise<JobOutcome>;
}
