// ============================================================================
// AGENCY — SUPERVISED GROWTH AGENT (bounded autonomy)
// ============================================================================
// The Growth agent is bounded-autonomous: it may evaluate the portfolio and
// create/advance BOUNDED experiments, but only through this supervised entry
// point, which composes the full agency chain around the EXISTING Phase 9
// growth engine (src/lib/growth/*):
//
//   Admin trigger (manual now; a future scheduler calls the same function)
//     → global agency pause check (fail-closed)
//     → contract stage check (growth contract: TRAFFIC/GROWTH only)
//     → portfolio evaluation from RECORDED data only
//     → NO-DATA SAFETY: NEEDS_DATA ⇒ WAIT_FOR_DATA, nothing executes
//     → halal gates (NOT_ALLOWED ⇒ blocked; REVIEW_REQUIRED ⇒ human review)
//     → tickGrowthLoop() — budget hard caps, stop-loss, idempotent experiment
//       creation, and the ONLY execution handoff: the existing Job Runner
//       (runJob 'ANALYTICS' for measurement). No parallel executor exists.
//     → AgentRun governance record (lifecycle steps, evidence refs)
//     → operational memory persistence (UPDATE_MEMORY, honest on failure)
//     → deterministic supervisor verdict from REAL run history
//     → structured brief for the Business Manager
//
// It never fabricates data, never spends without an allocation + caps, never
// raises its own limits, and never bypasses authorization, halal gates,
// budgets, idempotency, or audit. Generic supervised dispatch keeps refusing
// the growth agent (no single JobType fits a growth cycle); this module is
// the one and only supervised entry point for growth cycles.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { tickGrowthLoop, type GrowthDecisionType } from '@/lib/growth';
import type { TickResult } from '@/lib/growth/optimizer';
import { getBusinessManagerGrowthBrief, type BusinessManagerGrowthView } from '@/lib/growth/business-manager';
import { persistOperationalMemory } from '@/lib/ops/memory';
import { logger } from '@/lib/server-log';
import { getAgentContract } from './contracts';
import { evaluateLoops, evaluateOutput, supervisorVerdict } from './supervisor';
import { getAgencyControl, listAgentRuns, recordAgentRun, type LifecycleStepOutcome } from './runtime';
import type { SupervisorVerdict as Verdict } from './types';

export const GROWTH_CYCLE_JOB_TYPE = 'GROWTH_CYCLE';

export interface SupervisedGrowthInput {
  opportunityId: string;
  stage?: string;
  correlationId?: string;
}

export type GrowthCycleOutcome =
  | 'EXECUTED' // a measurement job actually ran through the Job Runner
  | 'EXPERIMENT_CREATED' // a bounded experiment was created (no spend without an allocation)
  | 'DECISION_RECORDED' // deterministic evaluate + decide cycle, no execution needed
  | 'WAIT_FOR_DATA' // NO-DATA SAFETY: insufficient recorded evidence, nothing executed
  | 'HUMAN_REVIEW' // halal REVIEW_REQUIRED — human must decide
  | 'BLOCKED' // halal NOT_ALLOWED or stopped health — nothing may run
  | 'PAUSED' // global agency pause
  | 'REFUSED'; // invalid input / unknown opportunity / contract violation

export type SupervisedGrowthResult = {
  ok: true;
  outcome: Exclude<GrowthCycleOutcome, 'PAUSED' | 'REFUSED'>;
  agentRunId: string | null;
  experimentId: string | null;
  jobId: string | null;
  jobStatus: string | null;
  verdict: Verdict;
  verdictReasons: string[];
  health: string;
  engineDecision: GrowthDecisionType | null;
  budget: { remainingUsd: number | null; paused: boolean } | null;
  brief: BusinessManagerGrowthView | null; // Business Manager consumption surface
  correlationId: string;
} | {
  ok: false;
  outcome: 'PAUSED' | 'REFUSED';
  reason: string;
  correlationId: string;
};

function budgetView(allocation: { monthlyBudgetUsd: number; spentThisMonthUsd: number; paused: boolean } | null): { remainingUsd: number | null; paused: boolean } | null {
  if (!allocation) return null;
  return {
    remainingUsd: Math.max(0, allocation.monthlyBudgetUsd - allocation.spentThisMonthUsd),
    paused: allocation.paused,
  };
}

type GrowthSuccessOutcome = Exclude<GrowthCycleOutcome, 'PAUSED' | 'REFUSED'>;

function mapTickToCycle(tick: TickResult): { outcome: GrowthSuccessOutcome; jobStatus: string; jobRan: boolean } {
  const action = tick.action;
  if (action.startsWith('ADVANCED_EXPERIMENT')) {
    const advanced = action.split(':')[1] ?? '';
    const failed = advanced === 'EXECUTION_FAILED' || advanced === 'EXECUTION_ERROR';
    return { outcome: 'EXECUTED', jobStatus: failed ? 'FAILED' : 'SUCCEEDED', jobRan: !failed };
  }
  if (action === 'EXPERIMENT_CREATED' || action === 'BOUNDED_EXPERIMENT_CREATED') {
    return { outcome: 'EXPERIMENT_CREATED', jobStatus: 'SUCCEEDED', jobRan: false };
  }
  if (action === 'EXPERIMENT_REFUSED' || action === 'SCALE_REFUSED' || action === 'ERROR' || action === 'REFUSED') {
    return { outcome: 'DECISION_RECORDED', jobStatus: 'FAILED', jobRan: false };
  }
  // RECORDED_STOP / RECORDED_PAUSE / RECORDED_REVIEW / NO_ACTION /
  // NO_EXPERIMENT_ADVANCED / ALLOCATION_PAUSED — deterministic decisions.
  return { outcome: 'DECISION_RECORDED', jobStatus: 'SUCCEEDED', jobRan: false };
}

/**
 * Run ONE supervised, bounded growth cycle for an opportunity.
 * At most one safe transition per cycle (same discipline as the Phase 8/9
 * loop controllers). Every branch is honest; nothing is fabricated.
 */
export async function runSupervisedGrowthCycle(input: SupervisedGrowthInput): Promise<SupervisedGrowthResult> {
  if (typeof input.opportunityId !== 'string' || input.opportunityId.trim().length === 0 || input.opportunityId.length > 128) {
    return { ok: false, outcome: 'REFUSED', reason: 'opportunityId is required (max 128 characters).', correlationId: '' };
  }
  const correlationId = (input.correlationId?.trim() || `growth-cycle:${randomUUID()}`).slice(0, 200);

  // 1. Global agency pause — fail closed.
  try {
    const control = await getAgencyControl();
    if (control.paused) {
      return { ok: false, outcome: 'PAUSED', reason: control.pauseReason ?? 'Agency is paused by the administrator.', correlationId };
    }
  } catch {
    return { ok: false, outcome: 'REFUSED', reason: 'Agency control state unavailable; refusing (fail-closed).', correlationId };
  }

  // 2. Contract stage check (growth contract allows TRAFFIC/GROWTH only).
  const contract = getAgentContract('growth');
  const stage = (input.stage || contract.allowedStages[0]).trim().toUpperCase();
  if (!contract.allowedStages.includes(stage as (typeof contract.allowedStages)[number])) {
    return { ok: false, outcome: 'REFUSED', reason: `stage '${stage}' is outside the growth agent's contract stages.`, correlationId };
  }

  // 3. Portfolio evaluation from RECORDED data only.
  const { evaluatePortfolioItem } = await import('@/lib/growth');
  const { db } = await import('@/lib/db');
  const portfolio = await evaluatePortfolioItem(input.opportunityId);
  if (!portfolio) {
    return { ok: false, outcome: 'REFUSED', reason: 'Opportunity not found; nothing executed.', correlationId };
  }
  const allocation = await db.resourceAllocation.findUnique({ where: { opportunityId: input.opportunityId } });
  const budget = budgetView(allocation);

  const lifecycle: LifecycleStepOutcome[] = [
    { step: 'PLAN', outcome: 'OK', detail: `health=${portfolio.health} traffic=${portfolio.traffic} conversions=${portfolio.conversions}` },
    { step: 'VALIDATE_INPUT', outcome: 'OK' },
    { step: 'SAFETY_CHECK', outcome: 'OK' },
  ];

  const recordCycle = async (args: {
    status: string;
    safetyVerdict: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
    failureReason?: string;
    skipExecute?: string;
    evidenceRefs?: { type: string; id: string }[];
  }): Promise<string | null> => {
    const steps = [...lifecycle];
    if (args.skipExecute) steps.push({ step: 'EXECUTE', outcome: 'SKIPPED', detail: args.skipExecute });
    steps.push({ step: 'VERIFY_OUTPUT', outcome: 'OK' });
    // UPDATE_MEMORY: every cycle outcome — including refusals and no-data —
    // lands in structured operational memory (honest SKIPPED on failure).
    let memoryStep: LifecycleStepOutcome = { step: 'UPDATE_MEMORY', outcome: 'OK' };
    try {
      await persistOperationalMemory({
        category: 'agent',
        source: 'agency:growth-agent',
        evidenceType: 'VERIFIED_DATA',
        relatedEntityType: 'OPPORTUNITY',
        relatedEntityId: input.opportunityId,
        opportunityId: input.opportunityId,
        observation: `Growth cycle at stage ${stage}: ${args.status}${args.failureReason ? ` — ${args.failureReason.slice(0, 300)}` : ''}`,
        outcome: args.status,
        applicability: 'future growth cycles for this opportunity',
      });
    } catch (memoryError) {
      memoryStep = { step: 'UPDATE_MEMORY', outcome: 'SKIPPED', detail: `memory store unavailable: ${String(memoryError).slice(0, 120)}` };
    }
    steps.push(memoryStep);
    steps.push({ step: 'PERSIST_RESULT', outcome: 'OK' });
    try {
      const record = await recordAgentRun({
        agentId: 'growth',
        jobId: null,
        jobType: GROWTH_CYCLE_JOB_TYPE,
        stage,
        status: args.status,
        correlationId,
        lifecycleSteps: steps,
        safetyVerdict: args.safetyVerdict,
        verification: 'NOT_APPLICABLE',
        failureReason: args.failureReason ?? null,
        evidenceRefs: args.evidenceRefs,
        retryCount: 0,
      });
      return record.id;
    } catch (error) {
      logger.warn('Growth AgentRun record failed (cycle outcome is still returned)', { error: String(error).slice(0, 150) });
      return null;
    }
  };

  // 4. Halal gates (defense in depth — the engine re-checks downstream).
  if (portfolio.halalStatus === 'NOT_ALLOWED') {
    const agentRunId = await recordCycle({
      status: 'BLOCKED', safetyVerdict: 'NOT_ALLOWED',
      failureReason: 'halalStatus is NOT_ALLOWED; no growth execution permitted.',
      skipExecute: 'halal gate refused execution',
    });
    return {
      ok: true, outcome: 'BLOCKED', agentRunId, experimentId: null, jobId: null, jobStatus: null,
      verdict: 'ESCALATE', verdictReasons: ['halalStatus is NOT_ALLOWED'],
      health: portfolio.health, engineDecision: 'STOP', budget, brief: null, correlationId,
    };
  }
  if (portfolio.halalStatus === 'REVIEW_REQUIRED') {
    const agentRunId = await recordCycle({
      status: 'HUMAN_REVIEW', safetyVerdict: 'REVIEW_REQUIRED',
      failureReason: 'halalStatus is REVIEW_REQUIRED; a qualified human must review before growth actions.',
      skipExecute: 'human review pending',
    });
    return {
      ok: true, outcome: 'HUMAN_REVIEW', agentRunId, experimentId: null, jobId: null, jobStatus: null,
      verdict: 'PAUSE', verdictReasons: ['halalStatus is REVIEW_REQUIRED'],
      health: portfolio.health, engineDecision: 'NEEDS_HUMAN_REVIEW', budget, brief: null, correlationId,
    };
  }

  // 5. NO-DATA SAFETY (Phase 14): insufficient recorded evidence ⇒ wait.
  if (portfolio.health === 'NEEDS_DATA') {
    const agentRunId = await recordCycle({
      status: 'BLOCKED', safetyVerdict: 'HALAL',
      failureReason: `INSUFFICIENT_EVIDENCE: only ${portfolio.traffic} recorded visitor(s) — no data, no experiment, no spend.`,
      skipExecute: 'NO_DATA: insufficient recorded evidence to act on',
    });
    return {
      ok: true, outcome: 'WAIT_FOR_DATA', agentRunId, experimentId: null, jobId: null, jobStatus: null,
      verdict: 'PROCEED', verdictReasons: ['no action taken: insufficient recorded data'],
      health: portfolio.health, engineDecision: 'CONTINUE', budget, brief: null, correlationId,
    };
  }

  // 6. Supervised bounded tick — the ONLY execution path (Job Runner inside).
  let tick: TickResult;
  try {
    tick = await tickGrowthLoop(input.opportunityId, { correlationId });
  } catch (error) {
    const message = String(error).slice(0, 300);
    const agentRunId = await recordCycle({ status: 'FAILED', safetyVerdict: 'HALAL', failureReason: `growth tick failed: ${message}` });
    return {
      ok: true, outcome: 'DECISION_RECORDED', agentRunId, experimentId: null, jobId: null, jobStatus: 'FAILED',
      verdict: 'PAUSE', verdictReasons: [`growth tick failed: ${message}`],
      health: portfolio.health, engineDecision: null, budget, brief: null, correlationId,
    };
  }

  const mapped = mapTickToCycle(tick);
  if (!tick.ok || mapped.jobStatus === 'FAILED') {
    const agentRunId = await recordCycle({
      status: 'FAILED', safetyVerdict: 'HALAL', failureReason: tick.reason.slice(0, 300),
      skipExecute: tick.action === 'REFUSED' ? 'tick refused' : undefined,
    });
    return {
      ok: true, outcome: 'DECISION_RECORDED', agentRunId, experimentId: tick.experimentId, jobId: tick.jobId,
      jobStatus: 'FAILED', verdict: 'PAUSE', verdictReasons: [tick.reason.slice(0, 200)],
      health: tick.health, engineDecision: tick.decision, budget, brief: null, correlationId,
    };
  }

  // 7. Lifecycle record + memory + supervisor, over the real tick outcome.
  lifecycle.push({
    step: 'EXECUTE',
    outcome: mapped.jobRan ? 'OK' : 'SKIPPED',
    detail: mapped.jobRan ? `job ${tick.jobId ?? 'n/a'} (${tick.action})` : tick.action,
  });

  let memoryStep: LifecycleStepOutcome = { step: 'UPDATE_MEMORY', outcome: 'OK' };
  try {
    await persistOperationalMemory({
      category: 'agent',
      source: 'agency:growth-agent',
      evidenceType: 'VERIFIED_DATA',
      relatedEntityType: 'OPPORTUNITY',
      relatedEntityId: input.opportunityId,
      opportunityId: input.opportunityId,
      observation: `Growth cycle: health ${tick.health}, decision ${tick.decision}, action ${tick.action} — ${tick.reason}`,
      outcome: tick.ok ? 'OK' : 'REFUSED',
      applicability: 'future growth cycles for this opportunity',
    });
  } catch (memoryError) {
    memoryStep = { step: 'UPDATE_MEMORY', outcome: 'SKIPPED', detail: `memory store unavailable: ${String(memoryError).slice(0, 120)}` };
  }
  lifecycle.push(memoryStep);
  lifecycle.push({ step: 'REPORT', outcome: 'OK' });

  const agentRunId = await (async () => {
    const evidenceRefs: { type: string; id: string }[] = [];
    if (tick.jobId && tick.jobId !== 'n/a') evidenceRefs.push({ type: 'JOB_RUN', id: tick.jobId });
    if (tick.experimentId) evidenceRefs.push({ type: 'EXPERIMENT', id: tick.experimentId });
    try {
      const record = await recordAgentRun({
        agentId: 'growth',
        jobId: tick.jobId && tick.jobId !== 'n/a' ? tick.jobId : null,
        jobType: GROWTH_CYCLE_JOB_TYPE,
        stage,
        status: mapped.jobStatus,
        correlationId,
        lifecycleSteps: lifecycle,
        safetyVerdict: 'HALAL',
        verification: mapped.jobRan ? 'PASSED' : 'NOT_APPLICABLE',
        failureReason: null,
        evidenceRefs,
        retryCount: 0,
      });
      return record.id;
    } catch (error) {
      logger.warn('Growth AgentRun record failed (cycle outcome is still returned)', { error: String(error).slice(0, 150) });
      return null;
    }
  })();

  // Supervisor post-run evaluation over REAL history (same as other agents).
  const output = evaluateOutput({
    status: mapped.jobStatus,
    fallbackUsed: false,
    safetyVerdict: 'HALAL',
    costUsd: 0, // per-cycle cost is owned by the AI economy ledger, not re-derived here
  });

  let recentIdenticalFailures = 0;
  let repeatedSafetyRejections = 0;
  try {
    const history = await listAgentRuns('growth', 10);
    // Window count (bounded to the 10 most recent runs): repeated failed
    // growth cycles must trip the detector even when a healthy cycle runs in
    // between — the loop-protection requirement is about accumulation, not
    // just adjacency.
    recentIdenticalFailures = history.filter(
      (r) => r.status === 'FAILED' && r.jobType === GROWTH_CYCLE_JOB_TYPE,
    ).length;
    repeatedSafetyRejections = history.filter((r) => r.safetyVerdict === 'NOT_ALLOWED').length;
  } catch {
    // History unavailable: loop evidence stays at honest defaults (none).
  }
  const loops = evaluateLoops({
    recentIdenticalJobs: 0, // experiment creation is idempotent on correlationId
    recentIdenticalFailures,
    exhaustedRetries: false, // job-level retries are bounded inside the Job Runner
    circularDelegation: false, // static delegation graph; cycles impossible by construction
    recentTokenUsage: 0, // token accounting is owned by the AI economy ledger
    recentCostUsd: 0,
    repeatedSafetyRejections,
    staleWorkflowMinutes: null,
  });

  const verdict = supervisorVerdict({ plan: { valid: true, reasons: [] }, output, loops, safetyViolation: false });

  // 8. Business Manager consumption surface (deterministic brief).
  let brief: BusinessManagerGrowthView | null = null;
  try {
    brief = await getBusinessManagerGrowthBrief(input.opportunityId);
  } catch {
    brief = null; // brief is enrichment, never a requirement
  }

  return {
    ok: true,
    outcome: mapped.outcome,
    agentRunId,
    experimentId: tick.experimentId,
    jobId: tick.jobId,
    jobStatus: mapped.jobRan ? mapped.jobStatus : null,
    verdict: verdict.verdict as Verdict,
    verdictReasons: verdict.reasons,
    health: tick.health,
    engineDecision: tick.decision,
    budget,
    brief,
    correlationId,
  };
}
