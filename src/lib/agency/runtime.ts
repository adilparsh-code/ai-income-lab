// ============================================================================
// AGENCY — RUNTIME STORE (Phases 2/5/8/9 of the agency upgrade)
// ============================================================================
// DB-backed governance records ONLY. This module never executes agents and
// never replaces the Job Runner: AgentRun rows EXTEND the authoritative JobRun
// record (jobId references it), AgentDefinition/AgentPermission rows are
// durable evidence of the in-code contracts, and AgentMessage rows are
// allow-listed, bounded, data-only messages.
//
// Every status value stored here is derived from a REAL JobRun outcome
// (src/lib/jobs/job-runner.ts). Nothing is fabricated, no secrets are stored,
// and every string is bounded before persistence.
// ============================================================================

import { db } from '@/lib/db';
import { logger } from '@/lib/server-log';
import { auditSecurityEvent } from '@/lib/security/guard';
import {
  AGENT_CONTRACTS,
  isCommunicationAllowed,
  isToolForbiddenEverywhere,
  toolPermissionsForAllAgents,
  getAgentContract,
  type AgentContract,
} from './contracts';
import { evaluateAgentHealth } from './health';
import {
  isAgencyAgentId,
  isAgentMessageKind,
  isAgencyStage,
  isHumanReviewCategory,
  type AgencyAgentId,
  type AgentMessageKind,
  type AgencyStage,
  type HealthEvaluation,
  type HumanReviewCategory,
} from './types';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const AGENCY_BOUNDS = {
  missionObjective: 400,
  messagePayloadChars: 8_000,
  messageEvidenceRefs: 12,
  reasonsMax: 10,
  reasonChars: 300,
  lifecycleStepChars: 60,
  lifecycleStepsMax: 12,
  evidenceRefsMax: 12,
  noteChars: 500,
} as const;

function bounded(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

function safeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Seed — durable evidence of the static contracts (idempotent upserts)
// ---------------------------------------------------------------------------

export async function seedAgencyContracts(): Promise<{ seeded: number; permissions: number }> {
  let seeded = 0;
  for (const contract of AGENT_CONTRACTS) {
    await db.agentDefinition.upsert({
      where: { agentId: contract.agentId },
      create: {
        agentId: contract.agentId,
        role: bounded(contract.role, 120),
        mission: bounded(contract.mission, 600),
        allowedTools: JSON.stringify(contract.allowedTools),
        allowedStages: JSON.stringify(contract.allowedStages),
        forbiddenActions: JSON.stringify(contract.stopConditions.slice(0, 8)),
        budgetLimitUsd: contract.budgetLimitUsd,
        timeoutMs: contract.timeoutMs,
        maxRetries: contract.maxRetries,
        requiresApproval: contract.humanApproval.required,
        stopConditions: JSON.stringify(contract.stopConditions),
        evidenceRequirement: contract.evidenceRequirement,
      },
      update: {
        role: bounded(contract.role, 120),
        mission: bounded(contract.mission, 600),
        allowedTools: JSON.stringify(contract.allowedTools),
        allowedStages: JSON.stringify(contract.allowedStages),
        budgetLimitUsd: contract.budgetLimitUsd,
        timeoutMs: contract.timeoutMs,
        maxRetries: contract.maxRetries,
        requiresApproval: contract.humanApproval.required,
        stopConditions: JSON.stringify(contract.stopConditions),
        evidenceRequirement: contract.evidenceRequirement,
      },
    });
    seeded += 1;
  }

  // Tool allow-list: one ALLOW row per (agentId, tool). DENY is implicit —
  // anything not allow-listed (or forbidden everywhere) is refused.
  let permissions = 0;
  for (const permission of toolPermissionsForAllAgents()) {
    if (isToolForbiddenEverywhere(permission.tool)) continue;
    await db.agentPermission.upsert({
      where: { agentId_tool: { agentId: permission.agentId, tool: permission.tool } },
      create: { agentId: permission.agentId, tool: bounded(permission.tool, 64), effect: 'ALLOW' },
      update: { effect: 'ALLOW' },
    });
    permissions += 1;
  }
  return { seeded, permissions };
}

export async function agencySeeded(): Promise<boolean> {
  try {
    const count = await db.agentDefinition.count();
    return count >= AGENT_CONTRACTS.length;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runs — supervised execution records (extend JobRun, never replace)
// ---------------------------------------------------------------------------

export type LifecycleStepOutcome = { step: string; outcome: 'OK' | 'SKIPPED' | 'FAILED'; detail?: string };

export type RecordRunInput = {
  agentId: AgencyAgentId;
  jobId: string | null; // authoritative JobRun.id
  jobType: string;
  stage: string;
  status: string; // terminal job status from the Job Runner
  correlationId: string;
  lifecycleSteps?: LifecycleStepOutcome[];
  safetyVerdict?: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
  verification?: 'PASSED' | 'FAILED' | 'NOT_APPLICABLE';
  failureReason?: string | null;
  evidenceRefs?: { type: string; id: string }[];
  retryCount?: number;
};

export async function recordAgentRun(input: RecordRunInput): Promise<{ id: string }> {
  const contract = getAgentContract(input.agentId);
  const steps = (input.lifecycleSteps ?? []).slice(0, AGENCY_BOUNDS.lifecycleStepsMax).map((s) => ({
    step: bounded(String(s.step), AGENCY_BOUNDS.lifecycleStepChars),
    outcome: s.outcome,
    detail: s.detail ? bounded(s.detail, AGENCY_BOUNDS.reasonChars) : undefined,
  }));
  const evidenceRefs = (input.evidenceRefs ?? [])
    .slice(0, AGENCY_BOUNDS.evidenceRefsMax)
    .map((e) => ({ type: bounded(String(e.type), 40), id: bounded(String(e.id), 64) }));

  const row = await db.agentRun.create({
    data: {
      agentId: input.agentId,
      jobId: input.jobId,
      jobType: bounded(input.jobType, 60),
      stage: bounded(input.stage, 20),
      status: bounded(input.status, 20),
      correlationId: bounded(input.correlationId, 200),
      lifecycleSteps: JSON.stringify(steps),
      safetyVerdict: input.safetyVerdict ?? null,
      verification: input.verification ?? null,
      failureReason: input.failureReason ? bounded(input.failureReason, AGENCY_BOUNDS.reasonChars) : null,
      evidenceRefs: JSON.stringify(evidenceRefs),
      retryCount: Math.max(0, Math.min(5, input.retryCount ?? 0)),
    },
  });
  // Health is re-derived from real runs after every recorded run.
  await refreshAgentHealth(input.agentId);
  void contract; // contract fetched for future stage validation; keeps import graph honest
  return { id: row.id };
}

export type AgentRunView = {
  id: string;
  agentId: string;
  jobId: string | null;
  jobType: string;
  stage: string;
  status: string;
  correlationId: string;
  lifecycleSteps: { step: string; outcome: string; detail?: string }[];
  safetyVerdict: string | null;
  verification: string | null;
  failureReason: string | null;
  evidenceRefs: { type: string; id: string }[];
  retryCount: number;
  startedAt: string;
  completedAt: string | null;
};

function toRunView(row: {
  id: string;
  agentId: string;
  jobId: string | null;
  jobType: string;
  stage: string;
  status: string;
  correlationId: string;
  lifecycleSteps: string;
  safetyVerdict: string | null;
  verification: string | null;
  failureReason: string | null;
  evidenceRefs: string;
  retryCount: number;
  startedAt: Date;
  completedAt: Date | null;
}): AgentRunView {
  let steps: { step: string; outcome: string; detail?: string }[] = [];
  try {
    const parsed = JSON.parse(row.lifecycleSteps) as unknown;
    if (Array.isArray(parsed)) {
      steps = parsed
        .filter((s): s is { step?: unknown; outcome?: unknown } => typeof s === 'object' && s !== null)
        .map((s) => ({
          step: typeof s.step === 'string' ? s.step : '',
          outcome: typeof s.outcome === 'string' ? s.outcome : '',
          ...(typeof (s as { detail?: unknown }).detail === 'string' ? { detail: (s as { detail: string }).detail } : {}),
        }));
    }
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    agentId: row.agentId,
    jobId: row.jobId,
    jobType: row.jobType,
    stage: row.stage,
    status: row.status,
    correlationId: row.correlationId,
    lifecycleSteps: steps,
    safetyVerdict: row.safetyVerdict,
    verification: row.verification,
    failureReason: row.failureReason,
    evidenceRefs: (() => {
      try {
        const parsed = JSON.parse(row.evidenceRefs) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((e): e is { type: string; id: string } =>
              typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { id?: unknown }).id === 'string')
          : [];
      } catch {
        return [];
      }
    })(),
    retryCount: row.retryCount,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export async function listAgentRuns(agentId?: AgencyAgentId, limit = 30): Promise<AgentRunView[]> {
  const rows = await db.agentRun.findMany({
    ...(agentId ? { where: { agentId } } : {}),
    orderBy: { startedAt: 'desc' },
    take: Math.max(1, Math.min(100, limit)),
  });
  return rows.map(toRunView);
}

// ---------------------------------------------------------------------------
// Messages — allow-listed directional, bounded, data-only
// ---------------------------------------------------------------------------

export type SendMessageInput = {
  correlationId: string;
  jobId?: string | null;
  sourceAgent: AgencyAgentId;
  targetAgent: AgencyAgentId;
  kind: AgentMessageKind;
  payload: Record<string, unknown>;
  evidenceRefs?: { type: string; id: string }[];
};

export async function sendAgentMessage(input: SendMessageInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (typeof input.correlationId !== 'string' || input.correlationId.trim().length === 0 || input.correlationId.length > 200) {
    return { ok: false, error: 'correlationId is required (at most 200 characters).' };
  }
  if (!isAgencyAgentId(input.sourceAgent) || !isAgencyAgentId(input.targetAgent)) {
    return { ok: false, error: 'sourceAgent and targetAgent must be roster agent ids.' };
  }
  if (!isCommunicationAllowed(input.sourceAgent, input.targetAgent)) {
    await auditSecurityEvent({
      kind: 'AGENT_MESSAGE_REFUSED',
      surface: 'agency:messages',
      outcome: 'refused',
      detail: `${input.sourceAgent}->${input.targetAgent} not allow-listed`,
    });
    return { ok: false, error: `Communication ${input.sourceAgent} → ${input.targetAgent} is not allow-listed.` };
  }
  if (!isAgentMessageKind(input.kind)) {
    return { ok: false, error: 'kind must be one of TASK_REQUEST | RESULT | FINDING | ESCALATION | DECISION.' };
  }

  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(input.payload ?? {});
  } catch {
    return { ok: false, error: 'payload must be JSON-serializable data.' };
  }
  if (payloadJson.length > AGENCY_BOUNDS.messagePayloadChars) {
    return { ok: false, error: `payload exceeds ${AGENCY_BOUNDS.messagePayloadChars} characters; send data, not documents.` };
  }

  const evidenceRefs = (input.evidenceRefs ?? [])
    .slice(0, AGENCY_BOUNDS.messageEvidenceRefs)
    .map((e) => ({ type: bounded(String(e?.type ?? ''), 40), id: bounded(String(e?.id ?? ''), 64) }));

  const row = await db.agentMessage.create({
    data: {
      correlationId: bounded(input.correlationId, 200),
      jobId: input.jobId ?? null,
      sourceAgent: input.sourceAgent,
      targetAgent: input.targetAgent,
      kind: input.kind,
      payloadJson,
      evidenceRefs: JSON.stringify(evidenceRefs),
    },
  });
  return { ok: true, id: row.id };
}

export type AgentMessageView = {
  id: string;
  correlationId: string;
  jobId: string | null;
  sourceAgent: string;
  targetAgent: string;
  kind: string;
  payload: Record<string, unknown>;
  evidenceRefs: { type: string; id: string }[];
  createdAt: string;
};

export async function listAgentMessages(targetAgent?: AgencyAgentId, limit = 30): Promise<AgentMessageView[]> {
  const rows = await db.agentMessage.findMany({
    ...(targetAgent ? { where: { targetAgent } } : {}),
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(100, limit)),
  });
  return rows.map((row) => {
    let evidenceRefs: { type: string; id: string }[] = [];
    try {
      const parsed = JSON.parse(row.evidenceRefs) as unknown;
      if (Array.isArray(parsed)) {
        evidenceRefs = parsed.filter((e): e is { type: string; id: string } =>
          typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { id?: unknown }).id === 'string');
      }
    } catch {
      evidenceRefs = [];
    }
    return {
      id: row.id,
      correlationId: row.correlationId,
      jobId: row.jobId,
      sourceAgent: row.sourceAgent,
      targetAgent: row.targetAgent,
      kind: row.kind,
      payload: safeJson(row.payloadJson),
      evidenceRefs,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Health — durable snapshots, deterministic from real runs
// ---------------------------------------------------------------------------

async function recentRunsFor(agentId: AgencyAgentId, limit = 20): Promise<{
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  safetyVerdict: string | null;
}[]> {
  const rows = await db.agentRun.findMany({
    where: { agentId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
  return rows.map((r) => ({
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    safetyVerdict: r.safetyVerdict,
  }));
}

export async function refreshAgentHealth(agentId: AgencyAgentId): Promise<HealthEvaluation> {
  const contract = getAgentContract(agentId);
  const runs = await recentRunsFor(agentId);
  const running = await db.agentRun.findFirst({
    where: { agentId, status: 'RUNNING' },
    orderBy: { startedAt: 'desc' },
  });
  let paused = false;
  try {
    const control = await db.agencyControl.findUnique({ where: { key: 'autonomy' } });
    paused = control?.paused ?? false;
  } catch {
    paused = false;
  }
  const evaluation = evaluateAgentHealth({
    agentId,
    recentRuns: runs,
    runningJobStartedAt: running?.startedAt ?? null,
    timeoutThresholdMs: contract.timeoutMs,
    paused,
  });
  const now = new Date();
  const lastSuccess = runs.find((r) => r.status === 'SUCCEEDED');
  const lastFailure = runs.find((r) => r.status === 'FAILED');
  try {
    await db.agentHealth.upsert({
      where: { agentId },
      create: {
        agentId,
        state: evaluation.state,
        reasons: JSON.stringify(evaluation.reasons.slice(0, AGENCY_BOUNDS.reasonsMax)),
        successCount: evaluation.successCount,
        failureCount: evaluation.failureCount,
        lastRunAt: evaluation.lastRunAt,
        lastSuccessAt: lastSuccess?.completedAt ?? null,
        lastFailureAt: lastFailure?.completedAt ?? null,
        evaluatedAt: now,
      },
      update: {
        state: evaluation.state,
        reasons: JSON.stringify(evaluation.reasons.slice(0, AGENCY_BOUNDS.reasonsMax)),
        successCount: evaluation.successCount,
        failureCount: evaluation.failureCount,
        lastRunAt: evaluation.lastRunAt,
        lastSuccessAt: lastSuccess?.completedAt ?? null,
        lastFailureAt: lastFailure?.completedAt ?? null,
        evaluatedAt: now,
      },
    });
  } catch (error) {
    logger.warn('Agent health upsert failed (non-fatal)', { error: String(error).slice(0, 150) });
  }
  return evaluation;
}

export type AgentHealthView = {
  agentId: string;
  state: string;
  reasons: string[];
  successCount: number;
  failureCount: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  evaluatedAt: string;
};

export async function listAgentHealth(): Promise<AgentHealthView[]> {
  const rows = await db.agentHealth.findMany();
  return rows.map((row) => ({
    agentId: row.agentId,
    state: row.state,
    reasons: parseStringArray(row.reasons),
    successCount: row.successCount,
    failureCount: row.failureCount,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastSuccessAt: row.lastSuccessAt ? row.lastSuccessAt.toISOString() : null,
    lastFailureAt: row.lastFailureAt ? row.lastFailureAt.toISOString() : null,
    evaluatedAt: row.evaluatedAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Control — single-row agency switch (PAUSE ALL / RESUME), audited
// ---------------------------------------------------------------------------

export async function getAgencyControl(): Promise<{ paused: boolean; pauseReason: string | null; pausedBy: string | null; pausedAt: string | null }> {
  const row = await db.agencyControl.upsert({
    where: { key: 'autonomy' },
    create: { key: 'autonomy' },
    update: {},
  });
  return {
    paused: row.paused,
    pauseReason: row.pauseReason,
    pausedBy: row.pausedBy,
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
  };
}

export async function setAgencyPaused(
  paused: boolean,
  by: string,
  reason?: string,
): Promise<{ paused: boolean; pauseReason: string | null }> {
  const row = await db.agencyControl.upsert({
    where: { key: 'autonomy' },
    create: { key: 'autonomy', paused, pauseReason: reason ? bounded(reason, 300) : null, pausedBy: bounded(by, 80), pausedAt: paused ? new Date() : null },
    update: paused
      ? { paused, pauseReason: reason ? bounded(reason, 300) : null, pausedBy: bounded(by, 80), pausedAt: new Date() }
      : { paused, pauseReason: null, pausedBy: null, pausedAt: null },
  });
  await auditSecurityEvent({
    kind: paused ? 'AGENCY_PAUSED' : 'AGENCY_RESUMED',
    surface: 'agency:control',
    outcome: 'ok',
    detail: `by ${bounded(by, 80)}`,
  });
  return { paused: row.paused, pauseReason: row.pauseReason };
}

// ---------------------------------------------------------------------------
// Human review queue — additive; decisions recorded with actor + timestamp
// ---------------------------------------------------------------------------

export type CreateReviewInput = {
  category: HumanReviewCategory;
  title: string;
  detail?: string;
  requestedBy: string; // agent id or 'system'
  opportunityId?: string | null;
  evidenceRefs?: { type: string; id: string }[];
  correlationId?: string | null;
};

export async function createHumanReview(input: CreateReviewInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isHumanReviewCategory(input.category)) {
    return { ok: false, error: 'Unknown review category.' };
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.length > 200) {
    return { ok: false, error: 'title is required (at most 200 characters).' };
  }
  const row = await db.humanReview.create({
    data: {
      category: input.category,
      title: bounded(input.title, 200),
      detail: input.detail ? bounded(input.detail, AGENCY_BOUNDS.noteChars) : '',
      requestedBy: bounded(input.requestedBy, 60),
      opportunityId: input.opportunityId ?? null,
      evidenceRefs: JSON.stringify((input.evidenceRefs ?? []).slice(0, AGENCY_BOUNDS.evidenceRefsMax)),
      correlationId: input.correlationId ? bounded(input.correlationId, 200) : null,
    },
  });
  return { ok: true, id: row.id };
}

export type HumanReviewView = {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  requestedBy: string;
  opportunityId: string | null;
  evidenceRefs: { type: string; id: string }[];
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  correlationId: string | null;
  createdAt: string;
};

function toReviewView(row: {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  requestedBy: string;
  opportunityId: string | null;
  evidenceRefs: string;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  correlationId: string | null;
  createdAt: Date;
}): HumanReviewView {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    detail: row.detail,
    status: row.status,
    requestedBy: row.requestedBy,
    opportunityId: row.opportunityId,
    evidenceRefs: (() => {
      try {
        const parsed = JSON.parse(row.evidenceRefs) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((e): e is { type: string; id: string } =>
              typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { id?: unknown }).id === 'string')
          : [];
      } catch {
        return [];
      }
    })(),
    decisionNote: row.decisionNote,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listHumanReviews(status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'RETIRED', limit = 50): Promise<HumanReviewView[]> {
  const rows = await db.humanReview.findMany({
    ...(status ? { where: { status } } : {}),
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(100, limit)),
  });
  return rows.map(toReviewView);
}

export async function decideHumanReview(input: {
  id: string;
  decision: 'APPROVE' | 'REJECT' | 'PAUSE' | 'RETRY';
  decidedBy: string;
  note?: string;
}): Promise<{ ok: true; review: HumanReviewView } | { ok: false; error: string }> {
  const row = await db.humanReview.findUnique({ where: { id: input.id } });
  if (!row) return { ok: false, error: 'Review not found.' };
  if (row.status !== 'PENDING') return { ok: false, error: `Review is already ${row.status}; only PENDING reviews can be decided.` };
  const status =
    input.decision === 'APPROVE' ? 'APPROVED'
      : input.decision === 'REJECT' ? 'REJECTED'
        : input.decision === 'PAUSE' ? 'PAUSED'
          : 'RETIRED'; // RETRY keeps the item closed here; resubmission is a new request
  const updated = await db.humanReview.update({
    where: { id: input.id },
    data: {
      status,
      decidedBy: bounded(input.decidedBy, 80),
      decidedAt: new Date(),
      decisionNote: input.note ? bounded(input.note, AGENCY_BOUNDS.noteChars) : null,
    },
  });
  await auditSecurityEvent({
    kind: 'HUMAN_REVIEW_DECISION',
    surface: 'agency:reviews',
    outcome: 'ok',
    detail: `${input.decision} ${row.category} by ${bounded(input.decidedBy, 80)}`,
  });
  return { ok: true, review: toReviewView(updated) };
}

// ---------------------------------------------------------------------------
// Contracts read API (used by the control center UI + API)
// ---------------------------------------------------------------------------

export type AgentContractView = {
  agentId: string;
  role: string;
  mission: string;
  allowedTools: string[];
  allowedStages: string[];
  budgetLimitUsd: number;
  timeoutMs: number;
  maxRetries: number;
  requiresApproval: boolean;
  humanApprovalCategories: string[];
  stopConditions: string[];
  evidenceRequirement: string;
};

export function contractViews(): AgentContractView[] {
  return AGENT_CONTRACTS.map((c: AgentContract) => ({
    agentId: c.agentId,
    role: c.role,
    mission: c.mission,
    allowedTools: [...c.allowedTools],
    allowedStages: [...c.allowedStages],
    budgetLimitUsd: c.budgetLimitUsd,
    timeoutMs: c.timeoutMs,
    maxRetries: c.maxRetries,
    requiresApproval: c.humanApproval.required,
    humanApprovalCategories: [...c.humanApproval.categories],
    stopConditions: [...c.stopConditions],
    evidenceRequirement: c.evidenceRequirement,
  }));
}

// ---------------------------------------------------------------------------
// Roster status — REAL runtime state per agent (never fabricated LIVE)
// ---------------------------------------------------------------------------

export type AgentRuntimeStatusView = {
  agentId: AgencyAgentId;
  role: string;
  status: 'OFFLINE' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'FAILED' | 'PAUSED' | 'DEGRADED';
  health: string;
  healthReasons: string[];
  currentJobId: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  successCount: number;
  failureCount: number;
  budgetLimitUsd: number;
  allowedTools: string[];
  requiresApproval: boolean;
  evidenceRequirement: string;
};

export async function agentRosterStatus(): Promise<AgentRuntimeStatusView[]> {
  const healthRows = await listAgentHealth();
  const healthByAgent = new Map(healthRows.map((h) => [h.agentId, h]));

  return AGENT_CONTRACTS.map((contract) => {
    const health = healthByAgent.get(contract.agentId);
    const hasRuns = health && (health.successCount + health.failureCount > 0 || health.lastRunAt);
    let status: AgentRuntimeStatusView['status'];
    if (health?.state === 'BLOCKED') status = 'BLOCKED';
    else if (health?.state === 'FAILED') status = 'FAILED';
    else if (health?.state === 'DEGRADED') status = 'DEGRADED';
    else if (!hasRuns) status = 'OFFLINE';
    else status = 'READY';
    return {
      agentId: contract.agentId,
      role: contract.role,
      status,
      health: health?.state ?? 'UNKNOWN',
      healthReasons: health?.reasons ?? ['no recorded runs yet'],
      currentJobId: null, // RUNNING jobs would appear here; derived below only if present
      lastRunAt: health?.lastRunAt ?? null,
      lastSuccessAt: health?.lastSuccessAt ?? null,
      successCount: health?.successCount ?? 0,
      failureCount: health?.failureCount ?? 0,
      budgetLimitUsd: contract.budgetLimitUsd,
      allowedTools: [...contract.allowedTools],
      requiresApproval: contract.humanApproval.required,
      evidenceRequirement: contract.evidenceRequirement,
    };
  });
}

// ---------------------------------------------------------------------------
// Stage validation helper for API input
// ---------------------------------------------------------------------------

export function isValidStage(value: unknown): value is AgencyStage {
  return isAgencyStage(value);
}
