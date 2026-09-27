// Phase 8A — Agent Mission System.
//
// Durable mission abstraction. Execution ALWAYS goes through the existing
// Job Runner (halal gates, idempotency, bounded retries). This module never
// executes agents, never injects env vars, never runs shell, and never
// fabricates traffic/revenue/publish/deploy outcomes.

import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { runJob } from '@/lib/jobs/job-runner';
import { isJobType, type JobPayload, type JobType } from '@/lib/jobs/types';
import { logger } from '@/lib/server-log';
import { classifyFailure, isRetryableFailureClass } from './failure-recovery';
import {
  ALLOWED_MISSION_CAPABILITIES,
  DEFAULT_MISSION_TIMEOUT_MS,
  FORBIDDEN_MISSION_CAPABILITIES,
  MAX_CONSTRAINT_LENGTH,
  MAX_CORRELATION_ID,
  MAX_MISSION_BUDGET_USD,
  MAX_MISSION_CONSTRAINTS,
  MAX_MISSION_OBJECTIVE,
  MAX_MISSION_TIMEOUT_MS,
  TERMINAL_MISSION_STATUSES,
  type MissionCapability,
  type MissionRecord,
  type MissionSpec,
  type MissionStatus,
} from './types';

const AGENT_TO_JOB: Record<string, JobType> = {
  research: 'RESEARCH',
  validation: 'VALIDATION',
  product: 'PRODUCT',
  analytics: 'ANALYTICS',
  'business-manager': 'BUSINESS_MANAGER',
};

export interface MissionValidation {
  valid: boolean;
  errors: string[];
}

export function validateMissionSpec(spec: Partial<MissionSpec>): MissionValidation {
  const errors: string[] = [];
  if (typeof spec.objective !== 'string' || spec.objective.trim().length === 0) {
    errors.push('objective is required');
  } else if (spec.objective.length > MAX_MISSION_OBJECTIVE) {
    errors.push(`objective must be at most ${MAX_MISSION_OBJECTIVE} characters`);
  }
  if (typeof spec.agentType !== 'string' || spec.agentType.trim().length === 0) {
    errors.push('agentType is required');
  }
  if (typeof spec.correlationId !== 'string' || spec.correlationId.trim().length === 0) {
    errors.push('correlationId is required');
  } else if (spec.correlationId.length > MAX_CORRELATION_ID) {
    errors.push(`correlationId must be at most ${MAX_CORRELATION_ID} characters`);
  }
  if (spec.opportunityId !== undefined && (typeof spec.opportunityId !== 'string' || spec.opportunityId.length > 128)) {
    errors.push('opportunityId must be a string of at most 128 characters');
  }
  if (spec.budgetUsd !== undefined) {
    if (typeof spec.budgetUsd !== 'number' || !Number.isFinite(spec.budgetUsd) || spec.budgetUsd < 0) {
      errors.push('budgetUsd must be a non-negative finite number');
    } else if (spec.budgetUsd > MAX_MISSION_BUDGET_USD) {
      errors.push(`budgetUsd exceeds the hard cap of $${MAX_MISSION_BUDGET_USD}`);
    }
  }
  if (spec.timeoutMs !== undefined) {
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
      errors.push('timeoutMs must be a positive integer');
    } else if (spec.timeoutMs > MAX_MISSION_TIMEOUT_MS) {
      errors.push(`timeoutMs exceeds ${MAX_MISSION_TIMEOUT_MS}ms`);
    }
  }
  if (spec.constraints !== undefined) {
    if (!Array.isArray(spec.constraints) || spec.constraints.some((c) => typeof c !== 'string')) {
      errors.push('constraints must be an array of strings');
    } else if (spec.constraints.length > MAX_MISSION_CONSTRAINTS) {
      errors.push(`at most ${MAX_MISSION_CONSTRAINTS} constraints`);
    } else if (spec.constraints.some((c) => c.length > MAX_CONSTRAINT_LENGTH)) {
      errors.push(`each constraint must be at most ${MAX_CONSTRAINT_LENGTH} characters`);
    }
  }
  if (spec.allowedCapabilities !== undefined) {
    if (!Array.isArray(spec.allowedCapabilities)) {
      errors.push('allowedCapabilities must be an array');
    } else {
      for (const cap of spec.allowedCapabilities) {
        if ((FORBIDDEN_MISSION_CAPABILITIES as readonly string[]).includes(String(cap))) {
          errors.push(`capability ${String(cap)} is forbidden`);
        } else if (!(ALLOWED_MISSION_CAPABILITIES as readonly string[]).includes(String(cap))) {
          errors.push(`unknown capability ${String(cap)}`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function toRecord(row: {
  id: string;
  objective: string;
  opportunityId: string | null;
  agentType: string;
  constraints: string;
  budgetUsd: number;
  allowedCapabilities: string;
  expectedOutput: string;
  successCriteria: string;
  failureCriteria: string;
  deadlineAt: Date | null;
  timeoutMs: number;
  approvalRequired: boolean;
  status: string;
  failureReason: string | null;
  correlationId: string;
  retryCount: number;
  resumePoint: string | null;
  lastError: string | null;
  failureClass: string | null;
  jobId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): MissionRecord {
  return {
    id: row.id,
    objective: row.objective,
    opportunityId: row.opportunityId,
    agentType: row.agentType,
    constraints: parseJsonArray(row.constraints),
    budgetUsd: row.budgetUsd,
    allowedCapabilities: parseJsonArray(row.allowedCapabilities) as MissionCapability[],
    expectedOutput: row.expectedOutput,
    successCriteria: row.successCriteria,
    failureCriteria: row.failureCriteria,
    deadlineAt: row.deadlineAt ? row.deadlineAt.toISOString() : null,
    timeoutMs: row.timeoutMs,
    approvalRequired: row.approvalRequired,
    status: row.status as MissionStatus,
    failureReason: row.failureReason,
    correlationId: row.correlationId,
    retryCount: row.retryCount,
    resumePoint: row.resumePoint,
    lastError: row.lastError,
    failureClass: (row.failureClass as MissionRecord['failureClass']) ?? null,
    jobId: row.jobId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function createMission(spec: MissionSpec): Promise<
  | { ok: true; mission: MissionRecord; deduplicated: boolean }
  | { ok: false; error: string; errors?: string[] }
> {
  const validation = validateMissionSpec(spec);
  if (!validation.valid) {
    return { ok: false, error: validation.errors.join('; '), errors: validation.errors };
  }

  const existing = await db.agentMission.findUnique({ where: { correlationId: spec.correlationId } });
  if (existing) {
    return { ok: true, mission: toRecord(existing), deduplicated: true };
  }

  if (spec.opportunityId) {
    const opportunity = await db.opportunity.findUnique({
      where: { id: spec.opportunityId },
      select: { id: true, halalStatus: true },
    });
    if (!opportunity) {
      return { ok: false, error: 'Opportunity not found. Mission was not created.' };
    }
    if (opportunity.halalStatus === 'NOT_ALLOWED') {
      const row = await db.agentMission.create({
        data: {
          objective: spec.objective.trim().slice(0, MAX_MISSION_OBJECTIVE),
          opportunityId: spec.opportunityId,
          agentType: spec.agentType,
          constraints: JSON.stringify((spec.constraints ?? []).slice(0, MAX_MISSION_CONSTRAINTS)),
          budgetUsd: spec.budgetUsd ?? 0,
          allowedCapabilities: JSON.stringify(spec.allowedCapabilities ?? []),
          expectedOutput: (spec.expectedOutput ?? '').slice(0, 1000),
          successCriteria: (spec.successCriteria ?? '').slice(0, 1000),
          failureCriteria: (spec.failureCriteria ?? '').slice(0, 1000),
          deadlineAt: spec.deadlineAt ? new Date(spec.deadlineAt) : null,
          timeoutMs: spec.timeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS,
          approvalRequired: spec.approvalRequired ?? false,
          status: 'BLOCKED',
          failureReason: 'Opportunity is NOT_ALLOWED. No mission execution is permitted.',
          correlationId: spec.correlationId,
        },
      });
      return { ok: true, mission: toRecord(row), deduplicated: false };
    }
  }

  const row = await db.agentMission.create({
    data: {
      objective: spec.objective.trim().slice(0, MAX_MISSION_OBJECTIVE),
      opportunityId: spec.opportunityId ?? null,
      agentType: spec.agentType,
      constraints: JSON.stringify((spec.constraints ?? []).slice(0, MAX_MISSION_CONSTRAINTS)),
      budgetUsd: spec.budgetUsd ?? 0,
      allowedCapabilities: JSON.stringify(spec.allowedCapabilities ?? []),
      expectedOutput: (spec.expectedOutput ?? '').slice(0, 1000),
      successCriteria: (spec.successCriteria ?? '').slice(0, 1000),
      failureCriteria: (spec.failureCriteria ?? '').slice(0, 1000),
      deadlineAt: spec.deadlineAt ? new Date(spec.deadlineAt) : null,
      timeoutMs: spec.timeoutMs ?? DEFAULT_MISSION_TIMEOUT_MS,
      approvalRequired: spec.approvalRequired ?? false,
      status: 'QUEUED',
      correlationId: spec.correlationId,
    },
  });
  return { ok: true, mission: toRecord(row), deduplicated: false };
}

export async function getMission(id: string): Promise<MissionRecord | null> {
  const row = await db.agentMission.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
}

export async function getMissionByCorrelation(correlationId: string): Promise<MissionRecord | null> {
  const row = await db.agentMission.findUnique({ where: { correlationId } });
  return row ? toRecord(row) : null;
}

export async function listMissions(limit = 40): Promise<MissionRecord[]> {
  const rows = await db.agentMission.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(100, Math.max(1, limit)),
  });
  return rows.map(toRecord);
}

/**
 * Prepare a queued mission: apply gates, never execute. HALAL → READY;
 * REVIEW_REQUIRED / approvalRequired → HUMAN_REVIEW; NOT_ALLOWED → BLOCKED.
 */
export async function prepareMission(id: string): Promise<MissionRecord | null> {
  const row = await db.agentMission.findUnique({ where: { id } });
  if (!row) return null;
  if (TERMINAL_MISSION_STATUSES.includes(row.status as MissionStatus) || row.status === 'READY' || row.status === 'RUNNING') {
    return toRecord(row);
  }

  let status: MissionStatus = 'READY';
  let failureReason: string | null = null;

  if (row.opportunityId) {
    const opportunity = await db.opportunity.findUnique({
      where: { id: row.opportunityId },
      select: { halalStatus: true },
    });
    if (!opportunity) {
      status = 'FAILED';
      failureReason = 'Opportunity disappeared before preparation.';
    } else if (opportunity.halalStatus === 'NOT_ALLOWED') {
      status = 'BLOCKED';
      failureReason = 'Opportunity is NOT_ALLOWED. No agent, no AI, no autonomous execution.';
    } else if (opportunity.halalStatus === 'REVIEW_REQUIRED') {
      status = 'HUMAN_REVIEW';
      failureReason = 'Opportunity is REVIEW_REQUIRED. No autonomous execution.';
    }
  }

  if (status === 'READY' && row.approvalRequired) {
    status = 'HUMAN_REVIEW';
    failureReason = 'Mission requires explicit human approval before execution.';
  }

  if (status === 'READY' && row.deadlineAt && row.deadlineAt.getTime() < Date.now()) {
    status = 'FAILED';
    failureReason = 'Mission deadline elapsed before execution.';
  }

  const updated = await db.agentMission.update({
    where: { id: row.id },
    data: { status, failureReason },
  });
  return toRecord(updated);
}

export interface RunMissionOptions {
  humanApprovalToken?: string;
  payload?: Record<string, unknown>;
}

export interface RunMissionResult {
  mission: MissionRecord;
  jobId: string | null;
  jobStatus: string | null;
  message: string;
}

/**
 * Execute a READY mission through the Job Runner. Never bypasses gates.
 * HUMAN_REVIEW / BLOCKED / CANCELLED missions are refused.
 */
export async function runMission(id: string, options: RunMissionOptions = {}): Promise<RunMissionResult | null> {
  const prepared = await prepareMission(id);
  if (!prepared) return null;

  if (prepared.status === 'BLOCKED' || prepared.status === 'HUMAN_REVIEW' || prepared.status === 'CANCELLED') {
    return {
      mission: prepared,
      jobId: null,
      jobStatus: null,
      message: prepared.failureReason ?? `Mission is ${prepared.status}; nothing executed.`,
    };
  }
  if (prepared.status === 'COMPLETED') {
    return { mission: prepared, jobId: prepared.jobId, jobStatus: 'SUCCEEDED', message: 'Mission already completed (idempotent).' };
  }
  if (prepared.status === 'FAILED' && !canRetryMission(prepared)) {
    return { mission: prepared, jobId: prepared.jobId, jobStatus: null, message: 'Mission failed with a non-retryable classification. Nothing re-executed.' };
  }
  if (prepared.status !== 'READY' && prepared.status !== 'QUEUED' && prepared.status !== 'WAITING' && prepared.status !== 'FAILED') {
    return { mission: prepared, jobId: prepared.jobId, jobStatus: null, message: `Mission cannot run from ${prepared.status}.` };
  }

  const jobType = resolveJobType(prepared);
  if (!jobType) {
    const failed = await db.agentMission.update({
      where: { id: prepared.id },
      data: {
        status: 'FAILED',
        failureReason: `Agent type "${prepared.agentType}" has no allowed job mapping.`,
        failureClass: 'VALIDATION',
        completedAt: new Date(),
      },
    });
    return { mission: toRecord(failed), jobId: null, jobStatus: null, message: 'Unknown agent type; nothing executed.' };
  }

  if (prepared.allowedCapabilities.length > 0 && !prepared.allowedCapabilities.includes(jobType as MissionCapability)) {
    const failed = await db.agentMission.update({
      where: { id: prepared.id },
      data: {
        status: 'FAILED',
        failureReason: `Job ${jobType} is not in the mission's allowed capabilities.`,
        failureClass: 'BUSINESS_RULE',
        completedAt: new Date(),
      },
    });
    return { mission: toRecord(failed), jobId: null, jobStatus: null, message: 'Capability not allowed; nothing executed.' };
  }

  await db.agentMission.update({
    where: { id: prepared.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  const payload = buildJobPayload(prepared, jobType, options);
  try {
    const outcome = await runJob(jobType, payload as JobPayload, prepared.correlationId);
    const mapped = mapJobToMission(outcome.status);
    const classification = outcome.error ? classifyFailure({ error: outcome.error, status: outcome.status }) : null;
    const updated = await db.agentMission.update({
      where: { id: prepared.id },
      data: {
        status: mapped,
        jobId: outcome.jobId === 'n/a' ? null : outcome.jobId,
        lastError: outcome.error,
        failureReason: mapped === 'COMPLETED' ? null : (outcome.error ?? `Job ended ${outcome.status}`),
        failureClass: classification?.classification ?? null,
        retryCount: outcome.retryCount,
        completedAt: new Date(),
      },
    });
    return {
      mission: toRecord(updated),
      jobId: outcome.jobId === 'n/a' ? null : outcome.jobId,
      jobStatus: outcome.status,
      message: mapped === 'COMPLETED'
        ? 'Mission completed through the Job Runner.'
        : `Mission ended ${mapped} (job ${outcome.status}).`,
    };
  } catch (error) {
    logger.error('Mission execution failed', { error: String(error) });
    const classification = classifyFailure({ error: String(error) });
    const updated = await db.agentMission.update({
      where: { id: prepared.id },
      data: {
        status: 'FAILED',
        lastError: String(error).slice(0, 300),
        failureReason: 'Runtime/storage error during mission execution. Nothing was fabricated.',
        failureClass: classification.classification,
        completedAt: new Date(),
      },
    });
    return { mission: toRecord(updated), jobId: null, jobStatus: null, message: updated.failureReason ?? 'Failed.' };
  }
}

export async function cancelMission(id: string): Promise<MissionRecord | null> {
  const row = await db.agentMission.findUnique({ where: { id } });
  if (!row) return null;
  if (TERMINAL_MISSION_STATUSES.includes(row.status as MissionStatus) && row.status !== 'HUMAN_REVIEW') {
    return toRecord(row);
  }
  const updated = await db.agentMission.update({
    where: { id },
    data: { status: 'CANCELLED', failureReason: 'Cancelled by operator.', completedAt: new Date() },
  });
  return toRecord(updated);
}

export function canRetryMission(mission: MissionRecord): boolean {
  if (mission.status !== 'FAILED') return false;
  if (!mission.failureClass) return false;
  return isRetryableFailureClass(mission.failureClass) && mission.retryCount < 3;
}

export function newMissionCorrelation(prefix = 'mission'): string {
  return `${prefix}:${randomUUID()}`;
}

function resolveJobType(mission: MissionRecord): JobType | null {
  if (isJobType(mission.agentType)) return mission.agentType;
  return AGENT_TO_JOB[mission.agentType] ?? null;
}

function mapJobToMission(status: string): MissionStatus {
  switch (status) {
    case 'SUCCEEDED': return 'COMPLETED';
    case 'BLOCKED': return 'BLOCKED';
    case 'HUMAN_REVIEW': return 'HUMAN_REVIEW';
    case 'DEGRADED': return 'WAITING';
    case 'FAILED': return 'FAILED';
    default: return 'FAILED';
  }
}

function buildJobPayload(mission: MissionRecord, jobType: JobType, options: RunMissionOptions): Record<string, unknown> {
  const extra = options.payload ?? {};
  const base: Record<string, unknown> = {
    ...extra,
    ...(mission.opportunityId ? { opportunityId: mission.opportunityId } : {}),
    ...(options.humanApprovalToken ? { humanApprovalToken: options.humanApprovalToken } : {}),
  };
  switch (jobType) {
    case 'RESEARCH':
      return { ...base, researchObjective: mission.objective };
    case 'VALIDATION':
      return { ...base, validationObjective: mission.objective };
    case 'PRODUCT':
      return { ...base, productObjective: mission.objective, productType: extra.productType ?? 'DIGITAL_PRODUCT' };
    case 'ANALYTICS':
      return { ...base, analyticsObjective: mission.objective };
    case 'BUSINESS_MANAGER':
      return { ...base, objective: mission.objective, decisionScope: extra.decisionScope ?? 'FULL_BUSINESS_REVIEW' };
    default:
      return base;
  }
}
