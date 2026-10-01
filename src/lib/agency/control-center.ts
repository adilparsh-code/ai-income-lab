// ============================================================================
// PHASE 10A — AGENT CONTROL CENTER (governed control layer)
// ============================================================================
// The single administrator's runtime control surface over the EXISTING agent
// architecture. This module is a thin, audited layer that composes:
//
//   Admin (verified session)
//     → validation + safety invariants (here, server-side)
//     → AgentConfigVersion (immutable, append-only versions)
//     → AgentControlState (per-agent intent/derived state)
//     → existing governance (global AgencyControl pause, supervisor plan
//       checks, Job Runner halal/idempotency gates)
//     → execution (only ever via the EXISTING Job Runner path)
//
// It NEVER edits source code, NEVER creates a second agent architecture,
// NEVER kills processes, NEVER deletes JobRun/AgentRun rows, and NEVER
// disables core safety (halal, fraud, spam, payment, SSRF, destructive-op
// gates). Runtime configuration is DATA; the static contracts in
// src/lib/agency/contracts.ts remain the permission ceiling: a stored config
// can only ever NARROW what the base contract allows, never widen it.
//
// Honesty rules: no fabricated live status, no fake Freebuff/Ruflo
// connections, restart failures surface truthful ERROR states, and every
// action is audited via AgentControlAction rows plus the existing
// SecurityEvent infrastructure.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import { describeRufloIntegration } from '@/lib/ruflo/capability';
import { getAgencyControl, setAgencyPaused, AGENCY_BOUNDS } from './runtime';
import { getAgentContract } from './contracts';
import { AGENCY_AGENT_IDS, isAgencyAgentId, type AgencyAgentId } from './types';

// ---------------------------------------------------------------------------
// Bounds + types
// ---------------------------------------------------------------------------

export const AGENT_CONTROL_DESIRED_STATES = ['RUNNING', 'PAUSED', 'STOPPED', 'RESTARTING'] as const;
export type AgentControlDesiredState = (typeof AGENT_CONTROL_DESIRED_STATES)[number];

export const AGENT_CONTROL_DERIVED_STATES = [
  'READY', 'RUNNING', 'PAUSED', 'STOPPED', 'RESTART_PENDING', 'BLOCKED', 'ERROR', 'DEGRADED',
] as const;
export type AgentControlDerivedState = (typeof AGENT_CONTROL_DERIVED_STATES)[number];

export const AGENT_CONTROL_ACTION_KINDS = [
  'PAUSE', 'RESUME', 'STOP', 'RESTART', 'SAVE_CONFIG', 'SAVE_RESTART', 'ROLLBACK', 'STOP_ALL', 'RESUME_ALL',
] as const;
export type AgentControlActionKind = (typeof AGENT_CONTROL_ACTION_KINDS)[number];

export type AgentControlActionResult =
  | { ok: true; action: AgentControlActionKind; agentId: string; previousState: string; newState: string; configVersion: number | null; correlationId: string; detail: string }
  | { ok: false; action: AgentControlActionKind; agentId: string; code: 'REFUSED' | 'FAILED'; error: string; correlationId: string };

/**
 * Agents whose governance flags can NEVER be weakened through runtime config.
 * The safety/halal screener, the supervisor, the Job Runner and the publishing
 * gate keep their human-approval requirement forever; the halal screener also
 * keeps its zero budget, zero retries and halal screening mission.
 */
export const APPROVAL_LOCKED_AGENTS: readonly AgencyAgentId[] = ['safety-halal', 'supervisor', 'job-runner', 'publishing'];
export const SAFETY_SCREENER_AGENT: AgencyAgentId = 'safety-halal';

// ---------------------------------------------------------------------------
// Runtime configuration schema (safe fields ONLY — never secrets)
// ---------------------------------------------------------------------------

const toolIdPattern = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;

const runtimeConfigShape = {
  mission: z.string().min(10).max(600),
  allowedTools: z.array(z.string().regex(toolIdPattern).max(64)).max(24),
  allowedStages: z.array(z.string().max(20)).min(1).max(14),
  forbiddenActions: z.array(z.string().max(80)).max(8),
  budgetLimitUsd: z.number().min(0).max(1000),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  maxRetries: z.number().int().min(0).max(5),
  requiresApproval: z.boolean(),
  stopConditions: z.array(z.string().max(80)).max(8),
  evidenceRequirement: z.enum(['AI_INFERENCE', 'SEARCH_DISCOVERY', 'VERIFIED_DATA', 'HUMAN_DECISION']),
} as const;

export const agentRuntimeConfigSchema = z.object(runtimeConfigShape).strict();
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

/** Fields the dashboard editor may change. Nothing else is ever accepted. */
export const EDITABLE_CONFIG_FIELDS = Object.keys(runtimeConfigShape) as (keyof AgentRuntimeConfig)[];

/** The static contract, projected into the runtime-config shape (the ceiling). */
export function baseConfigFor(agentId: AgencyAgentId): AgentRuntimeConfig {
  const c = getAgentContract(agentId);
  return {
    mission: c.mission,
    allowedTools: [...c.allowedTools],
    allowedStages: [...c.allowedStages],
    forbiddenActions: [...c.stopConditions.slice(0, 8)],
    budgetLimitUsd: c.budgetLimitUsd,
    timeoutMs: c.timeoutMs,
    maxRetries: c.maxRetries,
    requiresApproval: c.humanApproval.required,
    stopConditions: [...c.stopConditions],
    evidenceRequirement: c.evidenceRequirement,
  };
}

export type ConfigValidation =
  | { valid: true; config: AgentRuntimeConfig }
  | { valid: false; errors: string[] };

/**
 * Validate a candidate runtime config against the base contract.
 * Fail-closed rules:
 *  - schema + bounds (zod, server-side; the client is never trusted);
 *  - allowed tools ⊆ base tools (no capability escalation);
 *  - allowed stages ⊆ base stages (non-empty);
 *  - budget/timeout/retries ≤ base caps;
 *  - evidence requirement is immovable;
 *  - approval-locked agents can never lose requiresApproval;
 *  - the halal screener keeps zero budget, zero retries and a halal mission.
 */
export function validateConfigAgainstContract(raw: unknown, agentId: AgencyAgentId): ConfigValidation {
  const parsed = agentRuntimeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 10) };
  }
  const config = parsed.data;
  const base = baseConfigFor(agentId);
  const errors: string[] = [];

  const outsideTools = config.allowedTools.filter((t) => !base.allowedTools.includes(t));
  if (outsideTools.length > 0) {
    errors.push(`allowedTools: tools outside the base contract are not permitted (${outsideTools.slice(0, 3).join(', ')})`);
  }
  const outsideStages = config.allowedStages.filter((s) => !base.allowedStages.includes(s));
  if (outsideStages.length > 0) {
    errors.push(`allowedStages: stages outside the base contract are not permitted (${outsideStages.slice(0, 3).join(', ')})`);
  }
  if (config.budgetLimitUsd > base.budgetLimitUsd) {
    errors.push(`budgetLimitUsd: $${config.budgetLimitUsd} exceeds the base contract cap $${base.budgetLimitUsd}`);
  }
  if (config.timeoutMs > base.timeoutMs) {
    errors.push(`timeoutMs: ${config.timeoutMs} exceeds the base contract cap ${base.timeoutMs}`);
  }
  if (config.maxRetries > base.maxRetries) {
    errors.push(`maxRetries: ${config.maxRetries} exceeds the base contract cap ${base.maxRetries}`);
  }
  if (config.evidenceRequirement !== base.evidenceRequirement) {
    errors.push('evidenceRequirement is part of the safety contract and cannot be changed');
  }
  if ((APPROVAL_LOCKED_AGENTS as readonly string[]).includes(agentId) && config.requiresApproval !== true) {
    errors.push(`requiresApproval for '${agentId}' can never be disabled (governance-locked agent)`);
  }
  if (agentId === SAFETY_SCREENER_AGENT) {
    if (config.budgetLimitUsd !== 0) errors.push("budgetLimitUsd for the halal safety screener must stay 0 (deterministic screening, never spends)");
    if (config.maxRetries !== 0) errors.push("maxRetries for the halal safety screener must stay 0 (fail-closed, deterministic)");
    if (!config.mission.toLowerCase().includes('halal')) {
      errors.push("the halal safety screener's mission must keep its halal screening purpose");
    }
  }

  if (errors.length > 0) return { valid: false, errors: errors.slice(0, 10) };
  return { valid: true, config };
}

function changedFieldsBetween(prev: AgentRuntimeConfig, next: AgentRuntimeConfig): string[] {
  const changed: string[] = [];
  for (const field of EDITABLE_CONFIG_FIELDS) {
    if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) changed.push(field);
  }
  return changed;
}

function bounded(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

function safeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function newControlCorrelation(action: string, agentId: string): string {
  return bounded(`control:${action}:${agentId}:${randomUUID()}`, 200);
}

async function recordControlAction(input: {
  agentId: string;
  action: AgentControlActionKind;
  previousState: string | null;
  newState: string | null;
  configVersion: number | null;
  result: 'OK' | 'FAILED' | 'REFUSED';
  failureReason?: string | null;
  changedBy: string;
  correlationId: string;
  detail?: string;
}): Promise<void> {
  await db.agentControlAction.create({
    data: {
      agentId: bounded(input.agentId, 60),
      action: bounded(input.action, 40),
      previousState: input.previousState ? bounded(input.previousState, 30) : null,
      newState: input.newState ? bounded(input.newState, 30) : null,
      configVersion: input.configVersion,
      result: input.result,
      failureReason: input.failureReason ? bounded(input.failureReason, AGENCY_BOUNDS.reasonChars) : null,
      changedBy: bounded(input.changedBy, 120),
      correlationId: bounded(input.correlationId, 200),
      detail: input.detail ? bounded(input.detail, AGENCY_BOUNDS.noteChars) : '',
    },
  });
}

// ---------------------------------------------------------------------------
// Per-agent control state (upsert-latest-wins, mirrors AgencyControl style)
// ---------------------------------------------------------------------------

type ControlStateRow = {
  agentId: string;
  desiredState: string;
  derivedState: string;
  activeVersion: number | null;
  pendingRestart: boolean;
  stopReason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
};

async function getControlStateRow(agentId: AgencyAgentId): Promise<ControlStateRow> {
  const row = await db.agentControlState.upsert({
    where: { agentId },
    create: { agentId, desiredState: 'RUNNING', derivedState: 'READY' },
    update: {},
  });
  return row as unknown as ControlStateRow;
}

async function setControlState(
  agentId: AgencyAgentId,
  data: { desiredState?: AgentControlDesiredState; derivedState?: AgentControlDerivedState; pendingRestart?: boolean; stopReason?: string | null; updatedBy?: string; activeVersion?: number | null },
): Promise<ControlStateRow> {
  const row = await db.agentControlState.upsert({
    where: { agentId },
    create: {
      agentId,
      desiredState: data.desiredState ?? 'RUNNING',
      derivedState: data.derivedState ?? 'READY',
      pendingRestart: data.pendingRestart ?? false,
      stopReason: data.stopReason ?? null,
      updatedBy: data.updatedBy ?? null,
      ...(data.activeVersion !== undefined ? { activeVersion: data.activeVersion } : {}),
    },
    update: {
      ...(data.desiredState !== undefined ? { desiredState: data.desiredState } : {}),
      ...(data.derivedState !== undefined ? { derivedState: data.derivedState } : {}),
      ...(data.pendingRestart !== undefined ? { pendingRestart: data.pendingRestart } : {}),
      ...(data.stopReason !== undefined ? { stopReason: data.stopReason } : {}),
      ...(data.updatedBy !== undefined ? { updatedBy: data.updatedBy } : {}),
      ...(data.activeVersion !== undefined ? { activeVersion: data.activeVersion } : {}),
    },
  });
  return row as unknown as ControlStateRow;
}

/**
 * Job Runner dispatch gate (Phase 10A). True when NEW work must not begin for
 * this agent: STOPPED (admin stopped), PAUSED (admin paused) or RESTARTING.
 * Derived BLOCKED/ERROR states are informational here — the supervisor, health
 * layer and Job Runner halal gates remain authoritative for bad work.
 * Never corrupts rows; running work finishes under existing safe semantics.
 */
export async function isAgentControlBlocked(agentId: AgencyAgentId): Promise<{ blocked: boolean; reason?: string }> {
  const state = await getControlStateRow(agentId);
  if (state.desiredState === 'STOPPED') {
    return { blocked: true, reason: `Agent '${agentId}' is STOPPED by the administrator; no new work may begin.` };
  }
  if (state.desiredState === 'PAUSED') {
    return { blocked: true, reason: `Agent '${agentId}' is PAUSED by the administrator; no new work may begin.` };
  }
  if (state.desiredState === 'RESTARTING') {
    return { blocked: true, reason: `Agent '${agentId}' is RESTARTING; dispatch is held until the governed restart completes.` };
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Configuration persistence (immutable versions; rollback = new version)
// ---------------------------------------------------------------------------

async function nextConfigVersion(agentId: AgencyAgentId): Promise<number> {
  const latest = await db.agentConfigVersion.findFirst({
    where: { agentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return (latest?.version ?? 0) + 1;
}

async function persistConfigVersion(input: {
  agentId: AgencyAgentId;
  config: AgentRuntimeConfig;
  changedFields: string[];
  reason: string | null;
  changedBy: string;
  action: 'SAVE' | 'ROLLBACK' | 'BOOTSTRAP';
}): Promise<{ version: number }> {
  const version = await nextConfigVersion(input.agentId);
  await db.agentConfigVersion.create({
    data: {
      agentId: input.agentId,
      version,
      configJson: JSON.stringify(input.config),
      changedFields: JSON.stringify(input.changedFields.slice(0, 12)),
      reason: input.reason ? bounded(input.reason, AGENCY_BOUNDS.noteChars) : null,
      changedBy: bounded(input.changedBy, 120),
      action: input.action,
    },
  });
  await setControlState(input.agentId, { activeVersion: version });
  return { version };
}

export type SaveConfigInput = {
  agentId: AgencyAgentId;
  config: unknown; // validated server-side; never trusted from the client
  reason?: string | null;
  changedBy: string;
  correlationId?: string;
};

export type SaveConfigResult =
  | { ok: true; version: number; changedFields: string[]; correlationId: string }
  | { ok: false; errors: string[]; correlationId: string };

/**
 * SAVE: validate → persist a NEW immutable version → update the active
 * version pointer → audit. Does not start or stop anything.
 */
export async function saveAgentConfig(input: SaveConfigInput): Promise<SaveConfigResult> {
  const correlationId = input.correlationId ?? newControlCorrelation('SAVE_CONFIG', input.agentId);
  const validation = validateConfigAgainstContract(input.config, input.agentId);
  if (!validation.valid) {
    await recordControlAction({
      agentId: input.agentId, action: 'SAVE_CONFIG', previousState: null, newState: null, configVersion: null,
      result: 'REFUSED', failureReason: validation.errors.join('; '), changedBy: input.changedBy, correlationId,
      detail: 'configuration rejected by server-side validation',
    });
    await auditSecurityEvent({ kind: 'AGENT_CONTROL_REFUSED', surface: 'agency:control-center', outcome: 'refused', detail: `SAVE_CONFIG ${input.agentId}: invalid configuration` });
    return { ok: false, errors: validation.errors, correlationId };
  }

  try {
    const previous = await getActiveAgentConfig(input.agentId);
    const changedFields = previous
      ? changedFieldsBetween(previous.config, validation.config)
      : EDITABLE_CONFIG_FIELDS.filter((f) => JSON.stringify(baseConfigFor(input.agentId)[f]) !== JSON.stringify(validation.config[f]));
    const { version } = await persistConfigVersion({
      agentId: input.agentId,
      config: validation.config,
      changedFields,
      reason: input.reason ?? null,
      changedBy: input.changedBy,
      action: 'SAVE',
    });
    await setControlState(input.agentId, { updatedBy: input.changedBy });
    await recordControlAction({
      agentId: input.agentId, action: 'SAVE_CONFIG', previousState: null, newState: null, configVersion: version,
      result: 'OK', changedBy: input.changedBy, correlationId,
      detail: changedFields.length > 0 ? `changed: ${changedFields.join(', ')}` : 're-saved (no field changes)',
    });
    return { ok: true, version, changedFields, correlationId };
  } catch (error) {
    await recordControlAction({
      agentId: input.agentId, action: 'SAVE_CONFIG', previousState: null, newState: null, configVersion: null,
      result: 'FAILED', failureReason: String(error).slice(0, 200), changedBy: input.changedBy, correlationId,
      detail: 'persistence failed; configuration was NOT applied',
    });
    return { ok: false, errors: ['Configuration could not be persisted (storage error). Nothing was applied.'], correlationId };
  }
}

export type StoredAgentConfig = {
  version: number;
  config: AgentRuntimeConfig;
  changedFields: string[];
  reason: string | null;
  changedBy: string;
  action: string;
  createdAt: string;
};

export type StoredAgentConfigWithStatus = StoredAgentConfig & { active: boolean };

function toStoredConfig(row: {
  version: number; configJson: string; changedFields: string; reason: string | null; changedBy: string; action: string; createdAt: Date;
}): StoredAgentConfig | null {
  const parsed = safeJson(row.configJson);
  const validation = agentRuntimeConfigSchema.safeParse(parsed);
  // A stored version that no longer parses against the CURRENT schema is
  // surfaced as history only — never silently treated as the active config.
  if (!validation.success) return null;
  return {
    version: row.version,
    config: validation.data,
    changedFields: parseStringArray(row.changedFields),
    reason: row.reason,
    changedBy: row.changedBy,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The active (versioned) runtime config, or null when only the static contract applies. */
export async function getActiveAgentConfig(agentId: AgencyAgentId): Promise<StoredAgentConfig | null> {
  const row = await db.agentConfigVersion.findFirst({
    where: { agentId },
    orderBy: { version: 'desc' },
  });
  if (!row) return null;
  return toStoredConfig(row);
}

export async function getAgentConfigVersion(agentId: AgencyAgentId, version: number): Promise<StoredAgentConfig | null> {
  const row = await db.agentConfigVersion.findUnique({
    where: { agentId_version: { agentId, version } },
  });
  if (!row) return null;
  return toStoredConfig(row);
}

export async function getAgentConfigHistory(agentId: AgencyAgentId, limit = 50): Promise<{
  versions: (StoredAgentConfig & { active: boolean })[];
  activeVersion: number | null;
}> {
  const [rows, state] = await Promise.all([
    db.agentConfigVersion.findMany({
      where: { agentId },
      orderBy: { version: 'desc' },
      take: Math.max(1, Math.min(100, limit)),
    }),
    getControlStateRow(agentId),
  ]);
  const versions = rows
    .map((row) => toStoredConfig(row as unknown as Parameters<typeof toStoredConfig>[0]))
    .filter((v): v is StoredAgentConfig => v !== null)
    .map((v): StoredAgentConfigWithStatus => ({ ...v, active: v.version === state.activeVersion }));
  return { versions, activeVersion: state.activeVersion };
}

// ---------------------------------------------------------------------------
// Control actions (pause / resume / stop / restart) + emergency stop-all
// ---------------------------------------------------------------------------

export type ControlActionInput = {
  agentId: AgencyAgentId;
  action: Exclude<AgentControlActionKind, 'SAVE_CONFIG' | 'SAVE_RESTART' | 'ROLLBACK' | 'STOP_ALL' | 'RESUME_ALL'>;
  reason?: string | null;
  changedBy: string;
  correlationId?: string;
};

/**
 * Governance eligibility for RESUME: an agent must not be health-BLOCKED or
 * health-FAILED, must have no PENDING HumanReview, and its most recent run
 * must not be a safety rejection. RESTART is the explicit admin recovery path
 * for those states (it re-validates configuration); RESUME alone cannot
 * bypass a governance block.
 */
async function resumeEligibility(agentId: AgencyAgentId): Promise<{ eligible: boolean; reason?: string }> {
  const [health, pendingReview, lastRun] = await Promise.all([
    db.agentHealth.findUnique({ where: { agentId } }),
    db.humanReview.findFirst({ where: { requestedBy: agentId, status: 'PENDING' }, select: { id: true } }),
    db.agentRun.findFirst({ where: { agentId }, orderBy: { startedAt: 'desc' }, select: { safetyVerdict: true, status: true } }),
  ]);
  if (pendingReview) {
    return { eligible: false, reason: `Agent '${agentId}' is awaiting HumanReview; decide the pending review first.` };
  }
  if (lastRun?.safetyVerdict === 'NOT_ALLOWED') {
    return { eligible: false, reason: `Agent '${agentId}' was safety-blocked (NOT_ALLOWED); use RESTART after resolving the safety issue.` };
  }
  if (health?.state === 'BLOCKED') {
    return { eligible: false, reason: `Agent '${agentId}' is BLOCKED (${parseStringArray(health.reasons)[0] ?? 'governance block'}); use RESTART after resolving the issue.` };
  }
  if (health?.state === 'FAILED') {
    return { eligible: false, reason: `Agent '${agentId}' is FAILED; inspect the failure and use RESTART to recover.` };
  }
  return { eligible: true };
}

/**
 * In-process exclusion for one logical control action. Concurrent duplicate
 * requests (double-click, restart races) await the SAME in-flight promise, so
 * two simultaneous RESTARTs can never execute the state machine twice. The
 * sequential-replay case is covered by the durable AgentControlAction lookup
 * below. Cross-process duplicates additionally collapse through the state
 * machine's own idempotent transitions (already PAUSED → no-op, etc.).
 */
const inFlightActions = new Map<string, Promise<AgentControlActionResult>>();

function runExclusiveControlAction(key: string, fn: () => Promise<AgentControlActionResult>): Promise<AgentControlActionResult> {
  const existing = inFlightActions.get(key);
  if (existing) return existing;
  const promise = fn().finally(() => {
    inFlightActions.delete(key);
  });
  inFlightActions.set(key, promise);
  return promise;
}

export function applyControlAction(input: ControlActionInput): Promise<AgentControlActionResult> {
  const key = `${input.action}:${input.agentId}:${input.correlationId ?? 'auto'}`;
  return runExclusiveControlAction(key, () => applyControlActionUncorrelated(input));
}

async function applyControlActionUncorrelated(input: ControlActionInput): Promise<AgentControlActionResult> {
  const correlationId = input.correlationId ?? newControlCorrelation(input.action, input.agentId);

  // Idempotency: a replayed request with the same correlation id returns the
  // recorded outcome instead of double-executing (double-click safety).
  try {
    const existing = await db.agentControlAction.findFirst({
      where: { correlationId: bounded(correlationId, 200), agentId: bounded(input.agentId, 60), result: 'OK' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return {
        ok: true,
        action: existing.action as AgentControlActionKind,
        agentId: existing.agentId,
        previousState: existing.previousState ?? '',
        newState: existing.newState ?? '',
        configVersion: existing.configVersion,
        correlationId,
        detail: 'already applied (idempotent replay)',
      };
    }
  } catch {
    // Lookup failure must not block the action; the state machine below is
    // itself idempotent for repeated transitions.
  }

  try {
    const state = await getControlStateRow(input.agentId);
    const previous = state.desiredState;

    switch (input.action) {
      case 'PAUSE': {
        if (previous === 'PAUSED') {
          return { ok: true, action: 'PAUSE', agentId: input.agentId, previousState: previous, newState: previous, configVersion: state.activeVersion, correlationId, detail: 'already paused' };
        }
        if (previous === 'STOPPED') {
          await recordControlAction({ agentId: input.agentId, action: 'PAUSE', previousState: previous, newState: previous, configVersion: state.activeVersion, result: 'REFUSED', failureReason: 'agent is STOPPED; RESUME or RESTART it first', changedBy: input.changedBy, correlationId });
          return { ok: false, action: 'PAUSE', agentId: input.agentId, code: 'REFUSED', error: "Agent is STOPPED; RESUME or RESTART it first.", correlationId };
        }
        await setControlState(input.agentId, { desiredState: 'PAUSED', derivedState: 'PAUSED', stopReason: input.reason ? bounded(input.reason, 300) : 'paused by the administrator', updatedBy: input.changedBy });
        await recordControlAction({ agentId: input.agentId, action: 'PAUSE', previousState: previous, newState: 'PAUSED', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId, detail: input.reason ? bounded(input.reason, 200) : '' });
        return { ok: true, action: 'PAUSE', agentId: input.agentId, previousState: previous, newState: 'PAUSED', configVersion: state.activeVersion, correlationId, detail: 'paused; running work may finish, no new work will begin' };
      }

      case 'STOP': {
        if (previous === 'STOPPED') {
          return { ok: true, action: 'STOP', agentId: input.agentId, previousState: previous, newState: previous, configVersion: state.activeVersion, correlationId, detail: 'already stopped' };
        }
        await setControlState(input.agentId, { desiredState: 'STOPPED', derivedState: 'STOPPED', stopReason: input.reason ? bounded(input.reason, 300) : 'stopped by the administrator', updatedBy: input.changedBy });
        await recordControlAction({ agentId: input.agentId, action: 'STOP', previousState: previous, newState: 'STOPPED', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId, detail: 'stopped through Job Runner semantics; records preserved' });
        return { ok: true, action: 'STOP', agentId: input.agentId, previousState: previous, newState: 'STOPPED', configVersion: state.activeVersion, correlationId, detail: 'stopped; no new execution, existing records preserved' };
      }

      case 'RESUME': {
        if (previous === 'STOPPED') {
          // Admin resuming their own explicit stop is legitimate.
          await setControlState(input.agentId, { desiredState: 'RUNNING', derivedState: 'READY', stopReason: null, updatedBy: input.changedBy });
          await recordControlAction({ agentId: input.agentId, action: 'RESUME', previousState: previous, newState: 'RUNNING', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId });
          return { ok: true, action: 'RESUME', agentId: input.agentId, previousState: previous, newState: 'RUNNING', configVersion: state.activeVersion, correlationId, detail: 'resumed; all governance checks still apply' };
        }
        if (previous === 'RUNNING') {
          return { ok: true, action: 'RESUME', agentId: input.agentId, previousState: previous, newState: previous, configVersion: state.activeVersion, correlationId, detail: 'already running' };
        }
        const eligibility = await resumeEligibility(input.agentId);
        if (!eligibility.eligible) {
          await recordControlAction({ agentId: input.agentId, action: 'RESUME', previousState: previous, newState: previous, configVersion: state.activeVersion, result: 'REFUSED', failureReason: eligibility.reason ?? 'governance block', changedBy: input.changedBy, correlationId });
          await auditSecurityEvent({ kind: 'AGENT_CONTROL_REFUSED', surface: 'agency:control-center', outcome: 'refused', detail: `RESUME ${input.agentId}: governance block` });
          return { ok: false, action: 'RESUME', agentId: input.agentId, code: 'REFUSED', error: eligibility.reason ?? 'Resume refused by governance checks.', correlationId };
        }
        await setControlState(input.agentId, { desiredState: 'RUNNING', derivedState: 'READY', stopReason: null, updatedBy: input.changedBy });
        await recordControlAction({ agentId: input.agentId, action: 'RESUME', previousState: previous, newState: 'RUNNING', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId });
        return { ok: true, action: 'RESUME', agentId: input.agentId, previousState: previous, newState: 'RUNNING', configVersion: state.activeVersion, correlationId, detail: 'resumed through the governed execution path' };
      }

      case 'RESTART': {
        await setControlState(input.agentId, { desiredState: 'RESTARTING', derivedState: 'RESTART_PENDING', pendingRestart: true, updatedBy: input.changedBy });
        // Reload validated configuration: bootstrap v1 from the static contract
        // when no version exists, then re-validate the active version against
        // the CURRENT contract (a deploy may have tightened bounds — drift).
        try {
          let active = await getActiveAgentConfig(input.agentId);
          if (!active) {
            const base = baseConfigFor(input.agentId);
            const bootstrapped = await persistConfigVersion({
              agentId: input.agentId, config: base, changedFields: [], reason: 'restart bootstrap from the static contract',
              changedBy: input.changedBy, action: 'BOOTSTRAP',
            });
            const fetched = await getAgentConfigVersion(input.agentId, bootstrapped.version);
            if (!fetched) {
              throw new Error(`Bootstrap configuration v${bootstrapped.version} could not be re-read; restart aborted.`);
            }
            active = fetched;
          }
          const revalidation = validateConfigAgainstContract(active.config, input.agentId);
          if (!revalidation.valid) {
            await setControlState(input.agentId, {
              desiredState: 'PAUSED', derivedState: 'ERROR', pendingRestart: false,
              stopReason: `restart failed: stored configuration v${active.version} is no longer valid — ${revalidation.errors[0] ?? 'contract drift'}`,
              updatedBy: input.changedBy,
            });
            await recordControlAction({ agentId: input.agentId, action: 'RESTART', previousState: previous, newState: 'ERROR', configVersion: active.version, result: 'FAILED', failureReason: revalidation.errors.join('; '), changedBy: input.changedBy, correlationId, detail: 'restart failed; truthful ERROR state recorded' });
            await auditSecurityEvent({ kind: 'AGENT_CONTROL_RESTART_FAILED', surface: 'agency:control-center', outcome: 'error', detail: `${input.agentId} restart failed (configuration re-validation)` });
            return { ok: false, action: 'RESTART', agentId: input.agentId, code: 'FAILED', error: `Restart failed: stored configuration v${active.version} failed re-validation (${revalidation.errors[0] ?? 'contract drift'}). The agent is truthfully in ERROR/PAUSED state.`, correlationId };
          }
          await setControlState(input.agentId, { desiredState: 'RUNNING', derivedState: 'READY', pendingRestart: false, stopReason: null, updatedBy: input.changedBy, activeVersion: active.version });
          await recordControlAction({ agentId: input.agentId, action: 'RESTART', previousState: previous, newState: 'RUNNING', configVersion: active.version, result: 'OK', changedBy: input.changedBy, correlationId, detail: `restarted with validated configuration v${active.version}; execution resumes only through the governed path` });
          return { ok: true, action: 'RESTART', agentId: input.agentId, previousState: previous, newState: 'RUNNING', configVersion: active.version, correlationId, detail: `restarted with validated configuration v${active.version}` };
        } catch (error) {
          await setControlState(input.agentId, { desiredState: 'PAUSED', derivedState: 'ERROR', pendingRestart: false, stopReason: 'restart failed (storage error)', updatedBy: input.changedBy });
          await recordControlAction({ agentId: input.agentId, action: 'RESTART', previousState: previous, newState: 'ERROR', configVersion: null, result: 'FAILED', failureReason: String(error).slice(0, 200), changedBy: input.changedBy, correlationId, detail: 'restart failed; truthful ERROR state recorded' });
          await auditSecurityEvent({ kind: 'AGENT_CONTROL_RESTART_FAILED', surface: 'agency:control-center', outcome: 'error', detail: `${input.agentId} restart failed (storage error)` });
          return { ok: false, action: 'RESTART', agentId: input.agentId, code: 'FAILED', error: 'Restart failed (storage error). The agent is truthfully in ERROR/PAUSED state; nothing silently appears RUNNING.', correlationId };
        }
      }

      default: {
        const exhaustive: never = input.action;
        void exhaustive;
        return { ok: false, action: 'PAUSE', agentId: input.agentId, code: 'REFUSED', error: 'Unsupported control action.', correlationId };
      }
    }
  } catch (error) {
    await recordControlAction({
      agentId: input.agentId, action: input.action, previousState: null, newState: null, configVersion: null,
      result: 'FAILED', failureReason: String(error).slice(0, 200), changedBy: input.changedBy, correlationId,
      detail: 'control action failed (storage error)',
    }).catch(() => undefined);
    return { ok: false, action: input.action, agentId: input.agentId, code: 'FAILED', error: 'Control action failed (storage error). Nothing was fabricated.', correlationId };
  }
}

// ---------------------------------------------------------------------------
// Emergency STOP ALL / RESUME ALL (admin-only, heavily audited)
// ---------------------------------------------------------------------------

export type StopAllResult = {
  ok: true;
  globalPaused: boolean;
  changedAgents: string[];
  alreadyHeldAgents: string[];
  correlationId: string;
};

export type ResumeAllResult = {
  ok: true;
  globalResumed: boolean;
  resumedAgents: string[];
  skippedAgents: { agentId: string; reason: string }[];
  correlationId: string;
};

/**
 * STOP ALL: flips the EXISTING global AgencyControl pause (audited there) and
 * pauses every roster agent that is not already held. Never terminates
 * processes and never deletes or rewrites JobRun/AgentRun records; running
 * work finishes under existing safe semantics and no new work begins.
 */
export async function stopAllAgents(input: { changedBy: string; reason?: string | null; correlationId?: string }): Promise<StopAllResult> {
  const correlationId = input.correlationId ?? newControlCorrelation('STOP_ALL', '*');
  await setAgencyPaused(true, input.changedBy, input.reason ?? 'STOP ALL issued from the Agent Control Center.');

  const changedAgents: string[] = [];
  const alreadyHeldAgents: string[] = [];
  for (const agentId of AGENCY_AGENT_IDS) {
    try {
      const state = await getControlStateRow(agentId);
      if (state.desiredState === 'PAUSED' || state.desiredState === 'STOPPED') {
        alreadyHeldAgents.push(agentId);
        continue;
      }
      await setControlState(agentId, { desiredState: 'PAUSED', derivedState: 'PAUSED', stopReason: 'STOP ALL issued by the administrator', updatedBy: input.changedBy });
      await recordControlAction({ agentId, action: 'PAUSE', previousState: state.desiredState, newState: 'PAUSED', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId, detail: 'part of STOP ALL' });
      changedAgents.push(agentId);
    } catch {
      // A per-agent failure is recorded honestly in the summary; the global
      // pause (authoritative for dispatch) has already been applied above.
      alreadyHeldAgents.push(`${agentId} (state update failed)`);
    }
  }

  await recordControlAction({
    agentId: '*', action: 'STOP_ALL', previousState: 'RUNNING', newState: 'PAUSED', configVersion: null,
    result: 'OK', changedBy: input.changedBy, correlationId,
    detail: `global pause applied; ${changedAgents.length} agent(s) newly paused, ${alreadyHeldAgents.length} already held`,
  });
  return { ok: true, globalPaused: true, changedAgents, alreadyHeldAgents, correlationId };
}

/**
 * RESUME ALL: clears the global pause and resumes only GOVERNANCE-ELIGIBLE
 * agents. Agents that are BLOCKED, FAILED, awaiting HumanReview, or
 * safety-blocked are explicitly skipped (never automatically resumed).
 */
export async function resumeAllAgents(input: { changedBy: string; correlationId?: string }): Promise<ResumeAllResult> {
  const correlationId = input.correlationId ?? newControlCorrelation('RESUME_ALL', '*');
  await setAgencyPaused(false, input.changedBy, 'RESUME ALL issued from the Agent Control Center.');

  const resumedAgents: string[] = [];
  const skippedAgents: { agentId: string; reason: string }[] = [];
  for (const agentId of AGENCY_AGENT_IDS) {
    try {
      const state = await getControlStateRow(agentId);
      if (state.desiredState === 'STOPPED') {
        skippedAgents.push({ agentId, reason: 'explicitly stopped by the administrator (use RESUME/RESTART on the agent)' });
        continue;
      }
      if (state.desiredState !== 'PAUSED') {
        skippedAgents.push({ agentId, reason: `not paused (desiredState ${state.desiredState})` });
        continue;
      }
      const eligibility = await resumeEligibility(agentId);
      if (!eligibility.eligible) {
        skippedAgents.push({ agentId, reason: eligibility.reason ?? 'governance block' });
        continue;
      }
      await setControlState(agentId, { desiredState: 'RUNNING', derivedState: 'READY', stopReason: null, updatedBy: input.changedBy });
      await recordControlAction({ agentId, action: 'RESUME', previousState: 'PAUSED', newState: 'RUNNING', configVersion: state.activeVersion, result: 'OK', changedBy: input.changedBy, correlationId, detail: 'part of RESUME ALL' });
      resumedAgents.push(agentId);
    } catch {
      skippedAgents.push({ agentId, reason: 'state update failed (storage error); agent stays paused' });
    }
  }

  await recordControlAction({
    agentId: '*', action: 'RESUME_ALL', previousState: 'PAUSED', newState: 'RUNNING', configVersion: null,
    result: 'OK', changedBy: input.changedBy, correlationId,
    detail: `global pause cleared; ${resumedAgents.length} agent(s) resumed, ${skippedAgents.length} skipped by governance`,
  });
  return { ok: true, globalResumed: true, resumedAgents, skippedAgents, correlationId };
}

// ---------------------------------------------------------------------------
// SAVE & RESTART
// ---------------------------------------------------------------------------

export type SaveAndRestartResult =
  | { ok: true; version: number; changedFields: string[]; restart: { newState: string; correlationId: string }; correlationId: string }
  | { ok: false; stage: 'SAVE' | 'RESTART'; errors: string[]; correlationId: string };

/**
 * SAVE & RESTART: persist the new version, then run the governed restart
 * (safe stop/pause semantics → reload validated config → RUNNING intent).
 * A failed save never restarts; a failed restart surfaces a truthful ERROR.
 */
export async function saveAndRestartAgent(input: SaveConfigInput): Promise<SaveAndRestartResult> {
  const saveCorrelation = input.correlationId ?? newControlCorrelation('SAVE_RESTART', input.agentId);
  const saved = await saveAgentConfig({ ...input, correlationId: saveCorrelation });
  if (!saved.ok) {
    return { ok: false, stage: 'SAVE', errors: saved.errors, correlationId: saveCorrelation };
  }
  const restart = await applyControlAction({
    agentId: input.agentId, action: 'RESTART', changedBy: input.changedBy,
    reason: 'SAVE & RESTART', correlationId: newControlCorrelation('SAVE_RESTART:RESTART', input.agentId),
  });
  if (!restart.ok) {
    return { ok: false, stage: 'RESTART', errors: [restart.error], correlationId: restart.correlationId };
  }
  return {
    ok: true,
    version: saved.version,
    changedFields: saved.changedFields,
    restart: { newState: restart.newState, correlationId: restart.correlationId },
    correlationId: saveCorrelation,
  };
}

// ---------------------------------------------------------------------------
// Rollback (creates a NEW version; history is never mutated or deleted)
// ---------------------------------------------------------------------------

export type RollbackResult =
  | { ok: true; restoredFromVersion: number; newVersion: number; correlationId: string }
  | { ok: false; error: string; correlationId: string };

export async function rollbackAgentConfig(input: {
  agentId: AgencyAgentId;
  toVersion: number;
  changedBy: string;
  correlationId?: string;
}): Promise<RollbackResult> {
  const correlationId = input.correlationId ?? newControlCorrelation('ROLLBACK', input.agentId);
  try {
    const target = await getAgentConfigVersion(input.agentId, input.toVersion);
    if (!target) {
      return { ok: false, error: `Configuration version v${input.toVersion} does not exist for '${input.agentId}'.`, correlationId };
    }
    const revalidation = validateConfigAgainstContract(target.config, input.agentId);
    if (!revalidation.valid) {
      // The historical version can no longer satisfy the current contract —
      // refuse honestly instead of restoring something unsafe.
      await recordControlAction({ agentId: input.agentId, action: 'ROLLBACK', previousState: null, newState: null, configVersion: null, result: 'REFUSED', failureReason: revalidation.errors.join('; '), changedBy: input.changedBy, correlationId, detail: `rollback to v${input.toVersion} refused (contract drift)` });
      return { ok: false, error: `Rollback refused: v${input.toVersion} no longer satisfies the current safety contract (${revalidation.errors[0] ?? 'drift'}).`, correlationId };
    }
    const { version } = await persistConfigVersion({
      agentId: input.agentId,
      config: revalidation.config,
      changedFields: [`rollback-to-v${input.toVersion}`],
      reason: `rollback to v${input.toVersion}`,
      changedBy: input.changedBy,
      action: 'ROLLBACK',
    });
    await setControlState(input.agentId, { updatedBy: input.changedBy, pendingRestart: true });
    await recordControlAction({ agentId: input.agentId, action: 'ROLLBACK', previousState: null, newState: null, configVersion: version, result: 'OK', changedBy: input.changedBy, correlationId, detail: `v${version} = restored copy of v${input.toVersion}; restart to apply` });
    return { ok: true, restoredFromVersion: input.toVersion, newVersion: version, correlationId };
  } catch (error) {
    return { ok: false, error: `Rollback failed (storage error): ${String(error).slice(0, 120)}`, correlationId };
  }
}

// ---------------------------------------------------------------------------
// Read model — the Control Center view (composes existing rows only)
// ---------------------------------------------------------------------------

export type AgentControlView = {
  agentId: string;
  role: string;
  isExecutable: boolean; // maps onto an autonomous Job Runner job type
  executableDetail: string;
  control: {
    desiredState: AgentControlDesiredState;
    derivedState: AgentControlDerivedState;
    pendingRestart: boolean;
    stopReason: string | null;
    updatedAt: string | null;
    updatedBy: string | null;
  };
  health: { state: string; reasons: string[] } | null;
  currentTask: { jobId: string | null; jobType: string; stage: string; correlationId: string; startedAt: string } | null;
  lastRun: { id: string; jobType: string; stage: string; status: string; startedAt: string; completedAt: string | null; failureReason: string | null; safetyVerdict: string | null } | null;
  modelProvider: string | null;
  budget: { limitUsd: number; consumedUsd: number | null; quality: 'REAL' | 'UNKNOWN' };
  permissions: string[];
  governance: {
    requiresApproval: boolean;
    approvalLocked: boolean;
    globalPaused: boolean;
  };
  config: {
    activeVersion: number | null;
    lastConfigUpdateAt: string | null;
    lastConfigChangedBy: string | null;
    pendingRestart: boolean;
    drift: boolean;
    driftDetail: string | null;
  };
  effectiveConfig: AgentRuntimeConfig;
  baseConfig: AgentRuntimeConfig;
  lastControlAction: { action: string; result: string; at: string; by: string; configVersion: number | null; detail: string } | null;
};

export type ExternalExecutionSeam = {
  name: string;
  status: string;
  detail: string;
  requiredForConnected: string[];
};

export type ControlCenterView = {
  generatedAt: string;
  globalControl: { paused: boolean; pauseReason: string | null; pausedBy: string | null; pausedAt: string | null };
  agents: AgentControlView[];
  externalExecution: {
    freebuff: ExternalExecutionSeam;
    ruflo: ExternalExecutionSeam;
    policy: string;
  };
};

/** AGENT_TO_JOB mapping duplicated as data here to stay import-honest (the dispatcher owns the real map). */
const EXECUTABLE_AGENTS: ReadonlySet<string> = new Set(['research', 'validation', 'product', 'analytics', 'business-manager']);

export async function getControlCenterView(): Promise<ControlCenterView> {
  const globalControl = await getAgencyControl();

  const [stateRows, latestConfigs, recentActions, runs, healthRows, permissions, logRows] = await Promise.all([
    db.agentControlState.findMany(),
    db.agentConfigVersion.findMany({ orderBy: { version: 'desc' }, take: 13 * 3 }),
    db.agentControlAction.findMany({ orderBy: { createdAt: 'desc' }, take: 120 }),
    db.agentRun.findMany({ orderBy: { startedAt: 'desc' }, take: 500 }),
    db.agentHealth.findMany(),
    db.agentPermission.findMany(),
    db.agentLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { agentType: true, aiProvider: true, aiModel: true, estimatedCostUsd: true },
    }),
  ]);

  const stateByAgent = new Map(stateRows.map((r) => [(r as unknown as ControlStateRow).agentId, r as unknown as ControlStateRow]));
  const configByAgent = new Map<string, StoredAgentConfig>();
  for (const row of latestConfigs) {
    const stored = toStoredConfig(row as unknown as Parameters<typeof toStoredConfig>[0]);
    if (stored && !configByAgent.has(row.agentId)) configByAgent.set(row.agentId, stored);
  }
  const actionByAgent = new Map<string, AgentControlView['lastControlAction']>();
  for (const row of recentActions) {
    const key = row.agentId;
    if (key !== '*' && !actionByAgent.has(key)) {
      actionByAgent.set(key, {
        action: row.action,
        result: row.result,
        at: row.createdAt.toISOString(),
        by: row.changedBy,
        configVersion: row.configVersion,
        detail: row.detail,
      });
    }
  }
  const runsByAgent = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = runsByAgent.get(r.agentId) ?? [];
    list.push(r);
    runsByAgent.set(r.agentId, list);
  }
  const healthByAgent = new Map(healthRows.map((h) => [h.agentId, h]));
  const permissionsByAgent = new Map<string, string[]>();
  for (const p of permissions) {
    const list = permissionsByAgent.get(p.agentId) ?? [];
    list.push(p.tool);
    permissionsByAgent.set(p.agentId, list);
  }
  const costByAgent = new Map<string, { cost: number; entries: number; provider: string | null; model: string | null }>();
  for (const row of logRows) {
    const entry = costByAgent.get(row.agentType) ?? { cost: 0, entries: 0, provider: null, model: null };
    entry.entries += 1;
    if (typeof row.estimatedCostUsd === 'number') entry.cost += row.estimatedCostUsd;
    if (!entry.provider && row.aiProvider) entry.provider = row.aiProvider;
    if (!entry.model && row.aiModel) entry.model = row.aiModel;
    costByAgent.set(row.agentType, entry);
  }

  const agents: AgentControlView[] = AGENCY_AGENT_IDS.map((agentId) => {
    const base = baseConfigFor(agentId);
    const contract = getAgentContract(agentId);
    const state = stateByAgent.get(agentId);
    const stored = configByAgent.get(agentId);
    const health = healthByAgent.get(agentId) ?? null;
    const agentRuns = runsByAgent.get(agentId) ?? [];
    const currentRun = agentRuns.find((r) => r.status === 'QUEUED' || r.status === 'RUNNING') ?? null;
    const lastRun = agentRuns.find((r) => r.status !== 'QUEUED' && r.status !== 'RUNNING') ?? agentRuns[0] ?? null;
    const cost = costByAgent.get(agentId);

    const desiredState = (state?.desiredState ?? 'RUNNING') as AgentControlDesiredState;
    const configDrift = stored ? !validateConfigAgainstContract(stored.config, agentId).valid : false;

    // Derived state: honest precedence over the admin's intent. A recorded
    // ERROR (e.g. a failed restart) surfaces BEFORE the paused intent so a
    // failure is never hidden behind an ordinary PAUSED badge.
    let derivedState: AgentControlDerivedState;
    let stopReason = state?.stopReason ?? null;
    if (desiredState === 'STOPPED') derivedState = 'STOPPED';
    else if (state?.derivedState === 'ERROR') { derivedState = 'ERROR'; }
    else if (desiredState === 'PAUSED') derivedState = 'PAUSED';
    else if (desiredState === 'RESTARTING') derivedState = 'RESTART_PENDING';
    else if (globalControl.paused) { derivedState = 'PAUSED'; stopReason = stopReason ?? 'agency globally paused'; }
    else if (currentRun) derivedState = 'RUNNING';
    else if (health?.state === 'BLOCKED') derivedState = 'BLOCKED';
    else if (health?.state === 'FAILED') derivedState = 'ERROR';
    else if (health?.state === 'DEGRADED') derivedState = 'DEGRADED';
    else derivedState = 'READY';

    const effectiveConfig = stored?.config ?? base;

    return {
      agentId,
      role: contract.role,
      isExecutable: EXECUTABLE_AGENTS.has(agentId),
      executableDetail: EXECUTABLE_AGENTS.has(agentId)
        ? 'Dispatches through the Job Runner (runJob) via supervised dispatch.'
        : 'Infrastructure/coordination agent: no autonomous Job Runner job; control state still governs any future dispatch path.',
      control: {
        desiredState,
        derivedState,
        pendingRestart: state?.pendingRestart ?? false,
        stopReason,
        updatedAt: state?.updatedAt ? state.updatedAt.toISOString() : null,
        updatedBy: state?.updatedBy ?? null,
      },
      health: health ? { state: health.state, reasons: parseStringArray(health.reasons) } : null,
      currentTask: currentRun
        ? { jobId: currentRun.jobId, jobType: currentRun.jobType, stage: currentRun.stage, correlationId: currentRun.correlationId, startedAt: currentRun.startedAt.toISOString() }
        : null,
      lastRun: lastRun
        ? {
            id: lastRun.id, jobType: lastRun.jobType, stage: lastRun.stage, status: lastRun.status,
            startedAt: lastRun.startedAt.toISOString(),
            completedAt: lastRun.completedAt ? lastRun.completedAt.toISOString() : null,
            failureReason: lastRun.failureReason, safetyVerdict: lastRun.safetyVerdict,
          }
        : null,
      modelProvider: cost?.provider || cost?.model ? [cost?.provider, cost?.model].filter(Boolean).join(' / ') : null,
      budget: {
        limitUsd: effectiveConfig.budgetLimitUsd,
        consumedUsd: cost && cost.entries > 0 ? Math.round(cost.cost * 10000) / 10000 : null,
        quality: cost && cost.entries > 0 ? 'REAL' : 'UNKNOWN',
      },
      permissions: permissionsByAgent.get(agentId) ?? [...contract.allowedTools],
      governance: {
        requiresApproval: effectiveConfig.requiresApproval,
        approvalLocked: (APPROVAL_LOCKED_AGENTS as readonly string[]).includes(agentId),
        globalPaused: globalControl.paused,
      },
      config: {
        activeVersion: state?.activeVersion ?? stored?.version ?? null,
        lastConfigUpdateAt: stored?.createdAt ?? null,
        lastConfigChangedBy: stored?.changedBy ?? null,
        pendingRestart: state?.pendingRestart ?? false,
        drift: configDrift,
        driftDetail: configDrift ? 'stored configuration no longer satisfies the current safety contract; RESTART will truthfully fail until fixed' : null,
      },
      effectiveConfig,
      baseConfig: base,
      lastControlAction: actionByAgent.get(agentId) ?? null,
    };
  });

  // External execution seams — truthful, never fabricated.
  const ruflo = describeRufloIntegration();
  const freebuffSeam: ExternalExecutionSeam = {
    name: 'Freebuff (external execution provider)',
    status: 'NOT_CONNECTED',
    detail:
      'No Freebuff adapter exists in this repository. The governed boundary is '
      + 'AI Income Lab → Supervisor → Job Runner → approved execution adapter → provider. '
      + 'No connection is claimed and no external execution has occurred.',
    requiredForConnected: [
      'Implement a server-side Freebuff execution adapter behind the Job Runner',
      'Configure provider credentials server-side (never in the dashboard)',
      'Route first execution through supervised dispatch with halal + budget + audit gates',
    ],
  };
  const rufloSeam: ExternalExecutionSeam = {
    name: 'Ruflo (orchestration seam)',
    status: ruflo.status,
    detail: ruflo.detail,
    requiredForConnected: ruflo.unmetRequirements,
  };

  return {
    generatedAt: new Date().toISOString(),
    globalControl: {
      paused: globalControl.paused,
      pauseReason: globalControl.pauseReason,
      pausedBy: globalControl.pausedBy,
      pausedAt: globalControl.pausedAt,
    },
    agents,
    externalExecution: {
      freebuff: freebuffSeam,
      ruflo: rufloSeam,
      policy:
        'External execution providers may execute approved work only. They never bypass authentication, '
        + 'authorization, the Supervisor, safety/halal gates, budget limits, rate limits, human-review gates, '
        + 'or audit logging. The Job Runner remains the only executor.',
    },
  };
}

/** Guard helper for route validation. */
export function isKnownAgentId(value: unknown): value is AgencyAgentId {
  return isAgencyAgentId(value);
}
