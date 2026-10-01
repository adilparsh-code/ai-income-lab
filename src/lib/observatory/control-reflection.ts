// Phase 10A — Observatory CONTROL REFLECTION (read-only).
//
// The Observatory observes; the Control Center controls. This module keeps
// that separation honest: it reads the Phase 10A control rows (AgentControlState,
// AgentConfigVersion, AgentControlAction) and the existing AgentRun/AgentHealth/
// AgencyControl rows to produce a per-agent CONTROL STATE summary that the
// observatory can display. It performs no writes, exposes no control verbs,
// and never fabricates state: an agent with no control rows is 'READY' with
// config quality 'CONTRACT' (static contract active), never guessed.
//
// The control layer itself (src/lib/agency/control-center.ts) is the single
// writer; this module is a projection of exactly those rows.

import { db } from '@/lib/db';
import { isAgencyAgentId, AGENCY_AGENT_IDS } from '@/lib/agency/types';
import { getAgentContract } from '@/lib/agency/contracts';
import { validateConfigAgainstContract, baseConfigFor, agentRuntimeConfigSchema, type AgentRuntimeConfig } from '@/lib/agency/control-center';
import type { QualityValue } from './types';

export type AgentControlReflection = {
  agentId: string;
  role: string;
  /** Admin intent: RUNNING | PAUSED | STOPPED | RESTARTING (RUNNING when no control row exists). */
  desiredState: string;
  /** Honest current state (same derivation as the control-center read model). */
  derivedState: string;
  paused: boolean;
  stopped: boolean;
  pendingRestart: boolean;
  globalPaused: boolean;
  stopReason: string | null;
  governanceBlock: string | null;
  configuration: {
    /** Versioned runtime config active, or the static contract. */
    activeVersion: number | null;
    /** 'VERSIONED' (rows exist) or 'CONTRACT' (static contract in force). */
    quality: 'VERSIONED' | 'CONTRACT';
    lastConfigUpdateAt: string | null;
    lastConfigChangedBy: string | null;
    drift: boolean;
  };
  effectiveBudgetLimitUsd: number;
  lastControlAction: {
    action: string;
    result: string;
    at: string;
    by: string;
    configVersion: number | null;
  } | null;
};

export type ControlReflectionView = {
  generatedAt: string;
  globalPaused: boolean;
  globalPauseReason: string | null;
  agents: AgentControlReflection[];
  summary: {
    totalAgents: number;
    pausedAgents: number;
    stoppedAgents: number;
    pendingRestartAgents: number;
    driftedConfigs: number;
  };
  /** Provenance note: exactly which tables this projection reads. */
  sources: string[];
};

function safeJsonConfig(raw: string): AgentRuntimeConfig | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const check = agentRuntimeConfigSchema.safeParse(parsed);
    return check.success ? check.data : null;
  } catch {
    return null;
  }
}

export async function getControlReflection(): Promise<ControlReflectionView> {
  const [globalControlRow, stateRows, latestConfigs, recentActions, healthRows, pendingReviews, lastRuns] = await Promise.all([
    db.agencyControl.findUnique({ where: { key: 'autonomy' } }),
    db.agentControlState.findMany(),
    db.agentConfigVersion.findMany({ orderBy: { version: 'desc' }, take: 13 * 3 }),
    db.agentControlAction.findMany({ orderBy: { createdAt: 'desc' }, take: 120 }),
    db.agentHealth.findMany(),
    db.humanReview.findMany({ where: { status: 'PENDING' }, select: { requestedBy: true } }),
    db.agentRun.findMany({ orderBy: { startedAt: 'desc' }, take: 200, select: { agentId: true, status: true, safetyVerdict: true, startedAt: true } }),
  ]);

  const globalPaused = globalControlRow?.paused ?? false;
  const stateByAgent = new Map(stateRows.map((r) => [r.agentId, r]));
  const configByAgent = new Map<string, { version: number; config: AgentRuntimeConfig; createdAt: Date; changedBy: string }>();
  for (const row of latestConfigs) {
    const config = safeJsonConfig(row.configJson);
    if (config && !configByAgent.has(row.agentId)) {
      configByAgent.set(row.agentId, { version: row.version, config, createdAt: row.createdAt, changedBy: row.changedBy });
    }
  }
  const actionByAgent = new Map<string, NonNullable<AgentControlReflection['lastControlAction']>>();
  for (const row of recentActions) {
    if (row.agentId !== '*' && !actionByAgent.has(row.agentId)) {
      actionByAgent.set(row.agentId, {
        action: row.action,
        result: row.result,
        at: row.createdAt.toISOString(),
        by: row.changedBy,
        configVersion: row.configVersion,
      });
    }
  }
  const healthByAgent = new Map(healthRows.map((h) => [h.agentId, h]));
  const reviewAgents = new Set(pendingReviews.map((r) => r.requestedBy));
  const lastRunByAgent = new Map<string, { status: string; safetyVerdict: string | null }>();
  for (const run of lastRuns) {
    if (!lastRunByAgent.has(run.agentId)) lastRunByAgent.set(run.agentId, { status: run.status, safetyVerdict: run.safetyVerdict });
  }

  const agents: AgentControlReflection[] = AGENCY_AGENT_IDS.filter((id) => isAgencyAgentId(id)).map((agentId) => {
    const contract = getAgentContract(agentId);
    const state = stateByAgent.get(agentId);
    const stored = configByAgent.get(agentId);
    const health = healthByAgent.get(agentId);
    const lastRun = lastRunByAgent.get(agentId);

    const desiredState = state?.desiredState ?? 'RUNNING';
    let derivedState: string;
    let stopReason = state?.stopReason ?? null;
    let governanceBlock: string | null = null;
    if (desiredState === 'STOPPED') derivedState = 'STOPPED';
    else if (state?.derivedState === 'ERROR') { derivedState = 'ERROR'; governanceBlock = 'restart/control failure recorded'; }
    else if (desiredState === 'PAUSED') derivedState = 'PAUSED';
    else if (desiredState === 'RESTARTING') derivedState = 'RESTART_PENDING';
    else if (globalPaused) { derivedState = 'PAUSED'; stopReason = stopReason ?? 'agency globally paused'; }
    else if (reviewAgents.has(agentId)) { derivedState = 'BLOCKED'; governanceBlock = 'awaiting HumanReview'; }
    else if (health?.state === 'BLOCKED') { derivedState = 'BLOCKED'; governanceBlock = health.reasons ? 'health BLOCKED' : 'governance block'; }
    else if (health?.state === 'FAILED') { derivedState = 'ERROR'; governanceBlock = 'health FAILED'; }
    else if (lastRun?.safetyVerdict === 'NOT_ALLOWED') { derivedState = 'BLOCKED'; governanceBlock = 'safety rejection in recent runs'; }
    else derivedState = 'READY';

    const effective = stored?.config ?? baseConfigFor(agentId);
    const drift = stored ? !validateConfigAgainstContract(stored.config, agentId).valid : false;

    return {
      agentId,
      role: contract.role,
      desiredState,
      derivedState,
      paused: desiredState === 'PAUSED' || (!['STOPPED', 'RESTARTING'].includes(desiredState) && globalPaused),
      stopped: desiredState === 'STOPPED',
      pendingRestart: state?.pendingRestart ?? false,
      globalPaused,
      stopReason,
      governanceBlock,
      configuration: {
        activeVersion: stored?.version ?? null,
        quality: stored ? 'VERSIONED' : 'CONTRACT',
        lastConfigUpdateAt: stored ? stored.createdAt.toISOString() : null,
        lastConfigChangedBy: stored?.changedBy ?? null,
        drift,
      },
      effectiveBudgetLimitUsd: effective.budgetLimitUsd,
      lastControlAction: actionByAgent.get(agentId) ?? null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    globalPaused,
    globalPauseReason: globalControlRow?.pauseReason ?? null,
    agents,
    summary: {
      totalAgents: agents.length,
      pausedAgents: agents.filter((a) => a.paused && !a.stopped).length,
      stoppedAgents: agents.filter((a) => a.stopped).length,
      pendingRestartAgents: agents.filter((a) => a.pendingRestart).length,
      driftedConfigs: agents.filter((a) => a.configuration.drift).length,
    },
    sources: [
      'AgentControlState (per-agent desired/derived control state)',
      'AgentConfigVersion (immutable runtime configuration versions)',
      'AgentControlAction (control audit trail)',
      'AgencyControl (global pause switch)',
      'AgentHealth / AgentRun / HumanReview (governance block evidence)',
    ],
  };
}

/** QualityValue-compatible helper so observatory consumers keep provenance labels. */
export function controlStateQuality(reflection: AgentControlReflection): QualityValue<string> {
  return {
    value: reflection.derivedState,
    label: 'REAL',
    source: reflection.configuration.quality === 'VERSIONED'
      ? `AgentControlState + AgentConfigVersion v${reflection.configuration.activeVersion}`
      : 'AgentControlState + static contract (no runtime config versions)',
  };
}
