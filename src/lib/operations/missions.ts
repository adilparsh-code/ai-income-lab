import { db } from '@/lib/db';
import type { AgentType, EvidenceType } from '@/lib/agents/types';

export const MISSION_STATUSES = [
  'QUEUED', 'READY', 'RUNNING', 'WAITING', 'HUMAN_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface MissionInput {
  objective: string;
  opportunityId?: string | null;
  agentType: AgentType;
  constraints?: string[];
  budget?: number;
  allowedTools?: string[];
  expectedOutput?: string;
  successCriteria?: string[];
  failureCriteria?: string[];
  deadlineAt?: Date | null;
  approvalRequired?: boolean;
  correlationId: string;
}

export interface MissionView {
  id: string;
  objective: string;
  opportunityId: string | null;
  agentType: AgentType;
  constraints: string[];
  budget: number;
  allowedTools: string[];
  expectedOutput: string;
  successCriteria: string[];
  failureCriteria: string[];
  deadlineAt: string | null;
  approvalRequired: boolean;
  status: MissionStatus;
  failureReason: string | null;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const MAX_RETRIES = 2;
const AGENT_TYPES = new Set<AgentType>(['research', 'validation', 'product', 'analytics', 'business-manager']);
const TERMINAL_STATUSES = new Set<MissionStatus>(['HUMAN_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const CANCELLABLE_STATUSES = new Set<MissionStatus>(['QUEUED', 'READY', 'RUNNING', 'WAITING', 'HUMAN_REVIEW']);

function parseArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, 20) : [];
  } catch {
    return [];
  }
}

function clampText(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function boundedList(values: string[] | undefined): string[] {
  return (values ?? []).slice(0, 20).map((value) => clampText(value, 500));
}

function validateInput(input: MissionInput): string[] {
  const errors: string[] = [];
  if (!input.objective?.trim()) errors.push('objective is required');
  if (input.objective.length > 4000) errors.push('objective is too long');
  if (!AGENT_TYPES.has(input.agentType)) errors.push('agentType is not registered');
  if (!input.correlationId?.trim() || input.correlationId.length > 200) errors.push('correlationId is invalid');
  if (input.budget !== undefined && (!Number.isFinite(input.budget) || input.budget < 0 || input.budget > 1_000_000)) errors.push('budget must be between 0 and 1000000');
  if (input.deadlineAt && (!Number.isFinite(input.deadlineAt.getTime()) || input.deadlineAt.getTime() <= Date.now())) errors.push('deadlineAt must be a valid future date');
  return errors;
}

/** Create a bounded mission. It is queued only; execution still goes through the Job Runner. */
export async function createMission(input: MissionInput): Promise<MissionView> {
  const errors = validateInput(input);
  if (errors.length) throw new Error(`Invalid mission: ${errors.join('; ')}`);
  const row = await db.agentMission.create({
    data: {
      objective: clampText(input.objective, 4000),
      opportunityId: input.opportunityId ?? null,
      agentType: input.agentType,
      constraints: JSON.stringify(boundedList(input.constraints)),
      budget: input.budget ?? 0,
      allowedTools: JSON.stringify(boundedList(input.allowedTools)),
      expectedOutput: clampText(input.expectedOutput ?? '', 2000),
      successCriteria: JSON.stringify(boundedList(input.successCriteria)),
      failureCriteria: JSON.stringify(boundedList(input.failureCriteria)),
      deadlineAt: input.deadlineAt ?? null,
      approvalRequired: input.approvalRequired ?? false,
      status: input.approvalRequired ? 'HUMAN_REVIEW' : 'QUEUED',
      correlationId: input.correlationId,
    },
  });
  return toMissionView(row as MissionRow);
}

type MissionRow = {
  id: string; objective: string; opportunityId: string | null; agentType: string; constraints: string; budget: number;
  allowedTools: string; expectedOutput: string; successCriteria: string; failureCriteria: string; deadlineAt: Date | null;
  approvalRequired: boolean; status: string; failureReason: string | null; correlationId: string; createdAt: Date; startedAt: Date | null; completedAt: Date | null;
};

function toMissionView(row: MissionRow): MissionView {
  return {
    id: row.id, objective: row.objective, opportunityId: row.opportunityId, agentType: row.agentType as AgentType,
    constraints: parseArray(row.constraints), budget: row.budget, allowedTools: parseArray(row.allowedTools),
    expectedOutput: row.expectedOutput, successCriteria: parseArray(row.successCriteria), failureCriteria: parseArray(row.failureCriteria),
    deadlineAt: row.deadlineAt?.toISOString() ?? null, approvalRequired: row.approvalRequired, status: row.status as MissionStatus,
    failureReason: row.failureReason, correlationId: row.correlationId, createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export async function getMission(id: string): Promise<MissionView | null> {
  const row = await db.agentMission.findUnique({ where: { id } });
  return row ? toMissionView(row as MissionRow) : null;
}

/** Start a mission only when it is safe to execute. */
export async function startMission(id: string, now = new Date()): Promise<MissionView> {
  const mission = await getMission(id);
  if (!mission) throw new Error('Mission not found');
  if (TERMINAL_STATUSES.has(mission.status)) return mission;
  if (mission.deadlineAt && new Date(mission.deadlineAt).getTime() <= now.getTime()) {
    return updateMission(id, { status: 'FAILED', failureReason: 'Mission deadline elapsed.' });
  }
  return updateMission(id, { status: 'RUNNING', startedAt: now });
}

/** Complete a mission against explicit criteria; human review dominates completion. */
export async function completeMission(id: string, success: boolean, reason = ''): Promise<MissionView> {
  const mission = await getMission(id);
  if (!mission) throw new Error('Mission not found');
  if (TERMINAL_STATUSES.has(mission.status)) return mission;
  if (mission.status !== 'RUNNING' && mission.status !== 'WAITING') return mission;
  if (success && mission.successCriteria.length === 0) return updateMission(id, { status: 'HUMAN_REVIEW', failureReason: 'Success criteria are missing; human review is required.' });
  return updateMission(id, {
    status: success ? 'COMPLETED' : 'FAILED',
    failureReason: success ? null : clampText(reason || 'Mission failed its explicit criteria.', 500),
    completedAt: new Date(),
  });
}

async function updateMission(id: string, data: { status?: MissionStatus; failureReason?: string | null; startedAt?: Date | null; completedAt?: Date | null }): Promise<MissionView> {
  const row = await db.agentMission.update({ where: { id }, data: data as never });
  return toMissionView(row as MissionRow);
}

/** Safely pause/cancel a mission; this function never executes work. */
export async function cancelMission(id: string, reason = 'Cancelled by operator.'): Promise<MissionView> {
  const mission = await getMission(id);
  if (!mission) throw new Error('Mission not found');
  if (!CANCELLABLE_STATUSES.has(mission.status)) return mission;
  return updateMission(id, { status: 'CANCELLED', failureReason: clampText(reason, 500), completedAt: new Date() });
}

export { MAX_RETRIES as MISSION_MAX_RETRIES, type EvidenceType };
