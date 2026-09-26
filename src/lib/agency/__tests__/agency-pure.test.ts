// Agency upgrade — pure-module tests (no DB, no network, no AI).
// Covers agent contracts (Zod validity, uniqueness, tool/stage allow-lists),
// the deterministic supervisor (plan/output/loops/verdict), and health
// evaluation from real run history.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CONTRACTS,
  getAgentContract,
  isToolAllowedForAgent,
  isToolForbiddenEverywhere,
  isCommunicationAllowed,
  toolPermissionsForAllAgents,
} from '../contracts';
import { evaluateLoops, evaluatePlan, evaluateOutput, supervisorVerdict } from '../supervisor';
import { evaluateAgentHealth } from '../health';
import {
  AGENCY_AGENT_IDS,
  HUMAN_REVIEW_CATEGORIES,
  isAgencyAgentId,
  isHumanReviewCategory,
} from '../types';

describe('agency contracts (Phase 3/4/13)', () => {
  it('covers exactly the 13-agent roster with unique ids', () => {
    assert.equal(AGENT_CONTRACTS.length, AGENCY_AGENT_IDS.length);
    const ids = AGENT_CONTRACTS.map((c) => c.agentId).sort();
    assert.deepEqual(ids, [...AGENCY_AGENT_IDS].sort());
    assert.equal(new Set(ids).size, ids.length, 'agent ids must be unique');
  });

  it('every contract passes its own Zod validation', () => {
    for (const contract of AGENT_CONTRACTS) {
      assert.ok(contract.agentId, 'contract must have an id');
      assert.ok(contract.mission.length >= 10);
      assert.ok(contract.allowedStages.length >= 1);
      assert.ok(contract.timeoutMs >= 1_000 && contract.timeoutMs <= 600_000);
      assert.ok(contract.maxRetries >= 0 && contract.maxRetries <= 5);
    }
  });

  it('getAgentContract returns the right contract and throws on unknown ids', () => {
    const research = getAgentContract('research');
    assert.equal(research.role, 'Research Agent');
    assert.throws(() => getAgentContract('nonexistent' as never), /No contract registered/);
  });

  it('forbidden tools are refused even if allow-listed', () => {
    assert.ok(isToolForbiddenEverywhere('shell.exec'));
    assert.ok(isToolForbiddenEverywhere('db.raw-sql'));
    assert.equal(isToolAllowedForAgent('job-runner', 'shell.exec'), false);
    assert.equal(isToolAllowedForAgent('job-runner', 'jobs.dispatch'), true);
    assert.equal(isToolAllowedForAgent('research', 'jobs.dispatch'), false);
  });

  it('tool permission rows exist for every allow-listed tool', () => {
    const permissions = toolPermissionsForAllAgents();
    assert.ok(permissions.length > 0);
    for (const permission of permissions) {
      assert.ok(isAgencyAgentId(permission.agentId));
      assert.match(permission.tool, /^[a-z0-9-]+(\.[a-z0-9-]+)*$/);
    }
  });

  it('communication allow-list is directional and excludes self-messages', () => {
    assert.equal(isCommunicationAllowed('business-manager', 'research'), true);
    assert.equal(isCommunicationAllowed('research', 'business-manager'), false);
    assert.equal(isCommunicationAllowed('research', 'research'), false);
    assert.equal(isCommunicationAllowed('ruflo-adapter', 'product'), false);
  });
});

describe('agency supervisor (Phase 10/11)', () => {
  const basePlan = {
    agentId: 'research' as const,
    stage: 'RESEARCH',
    jobType: 'RESEARCH',
    budgetUsd: 1,
    timeoutMs: 120_000,
    retryCount: 0,
  };
  const researchContract = getAgentContract('research');

  it('a valid in-contract plan passes', () => {
    const plan = evaluatePlan(basePlan, {
      allowedStages: researchContract.allowedStages,
      budgetLimitUsd: researchContract.budgetLimitUsd,
      timeoutMs: researchContract.timeoutMs,
      maxRetries: researchContract.maxRetries,
    });
    assert.equal(plan.valid, true);
    assert.deepEqual(plan.reasons, []);
  });

  it('out-of-contract stage, budget, and timeout are refused', () => {
    const plan = evaluatePlan(
      { ...basePlan, stage: 'PUBLISH', budgetUsd: 99, timeoutMs: 999_999 },
      {
        allowedStages: researchContract.allowedStages,
        budgetLimitUsd: researchContract.budgetLimitUsd,
        timeoutMs: researchContract.timeoutMs,
        maxRetries: researchContract.maxRetries,
      },
    );
    assert.equal(plan.valid, false);
    assert.ok(plan.reasons.some((r) => r.includes('stage')));
    assert.ok(plan.reasons.some((r) => r.includes('budget')));
    assert.ok(plan.reasons.some((r) => r.includes('timeout')));
  });

  it('SUCCEEDED + fallbackUsed is never a valid output (honest statuses)', () => {
    const output = evaluateOutput({ status: 'SUCCEEDED', fallbackUsed: true, safetyVerdict: 'HALAL', costUsd: 0 });
    assert.equal(output.valid, false);
    assert.ok(output.reasons.some((r) => r.includes('fallback')));
  });

  it('NOT_ALLOWED safety verdict never validates executed output', () => {
    const output = evaluateOutput({ status: 'SUCCEEDED', fallbackUsed: false, safetyVerdict: 'NOT_ALLOWED', costUsd: 0 });
    assert.equal(output.valid, false);
  });

  it('each loop detector fires at its threshold', () => {
    const loops = evaluateLoops({
      recentIdenticalJobs: 6,
      recentIdenticalFailures: 4,
      exhaustedRetries: true,
      circularDelegation: true,
      recentTokenUsage: 500_000,
      recentCostUsd: 11,
      repeatedSafetyRejections: 3,
      staleWorkflowMinutes: 2_000,
    });
    assert.equal(loops.quarantined, true);
    const detectors = loops.findings.map((f) => f.detector).sort();
    assert.deepEqual(detectors, [
      'CIRCULAR_DELEGATION',
      'EXCESSIVE_COST',
      'EXCESSIVE_TOKEN_USAGE',
      'REPEATED_IDENTICAL_FAILURES',
      'REPEATED_IDENTICAL_JOBS',
      'REPEATED_SAFETY_REJECTION',
      'RETRY_EXHAUSTION',
      'STALE_WORKFLOW',
    ]);
  });

  it('clean history produces no loop findings', () => {
    const loops = evaluateLoops({
      recentIdenticalJobs: 1,
      recentIdenticalFailures: 0,
      exhaustedRetries: false,
      circularDelegation: false,
      recentTokenUsage: 1_000,
      recentCostUsd: 0.1,
      repeatedSafetyRejections: 0,
      staleWorkflowMinutes: 30,
    });
    assert.equal(loops.quarantined, false);
    assert.deepEqual(loops.findings, []);
  });

  it('verdict precedence: safety violation escalates over loop quarantine', () => {
    const result = supervisorVerdict({
      plan: { valid: true, reasons: [] },
      output: { valid: true, reasons: [] },
      loops: { quarantined: true, findings: [{ detector: 'REPEATED_IDENTICAL_JOBS', reason: 'too many' }] },
      safetyViolation: true,
    });
    assert.equal(result.verdict, 'ESCALATE');
    assert.equal(result.loopDetected, true);
    assert.equal(result.safetyViolation, true);
  });

  it('verdict precedence: loop findings quarantine before pause', () => {
    const result = supervisorVerdict({
      plan: { valid: false, reasons: ['bad stage'] },
      output: null,
      loops: { quarantined: true, findings: [{ detector: 'RETRY_EXHAUSTION', reason: 'exhausted' }] },
      safetyViolation: false,
    });
    assert.equal(result.verdict, 'QUARANTINE');
  });

  it('invalid plan pauses when nothing worse applies', () => {
    const result = supervisorVerdict({
      plan: { valid: false, reasons: ['budget exceeded'] },
      output: { valid: true, reasons: [] },
      loops: { quarantined: false, findings: [] },
      safetyViolation: false,
    });
    assert.equal(result.verdict, 'PAUSE');
    assert.equal(result.budgetViolation, true);
  });

  it('valid plan + valid output proceeds', () => {
    const result = supervisorVerdict({
      plan: { valid: true, reasons: [] },
      output: { valid: true, reasons: [] },
      loops: { quarantined: false, findings: [] },
      safetyViolation: false,
    });
    assert.equal(result.verdict, 'PROCEED');
  });
});

describe('agency health evaluation (Phase 10)', () => {
  const baseInput = {
    agentId: 'research' as const,
    recentRuns: [] as { status: string; startedAt: Date; completedAt: Date | null; safetyVerdict: string | null }[],
    runningJobStartedAt: null as Date | null,
    timeoutThresholdMs: 120_000,
    paused: false,
  };

  it('no runs and nothing running is UNKNOWN — never fabricated healthy', () => {
    const evaluation = evaluateAgentHealth(baseInput);
    assert.equal(evaluation.state, 'UNKNOWN');
    assert.equal(evaluation.successCount, 0);
  });

  it('paused agents are BLOCKED regardless of history', () => {
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      paused: true,
      recentRuns: [{ status: 'SUCCEEDED', startedAt: new Date(), completedAt: new Date(), safetyVerdict: 'HALAL' }],
    });
    assert.equal(evaluation.state, 'BLOCKED');
    assert.match(evaluation.reasons[0], /paused/);
  });

  it('a running job past the timeout is DEGRADED (stuck)', () => {
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      runningJobStartedAt: new Date(Date.now() - 200_000),
      timeoutThresholdMs: 120_000,
    });
    assert.equal(evaluation.state, 'DEGRADED');
    assert.match(evaluation.reasons[0], /timeout/);
  });

  it('3 consecutive failures is FAILED', () => {
    const now = Date.now();
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      recentRuns: [
        { status: 'FAILED', startedAt: new Date(now), completedAt: new Date(now), safetyVerdict: 'HALAL' },
        { status: 'FAILED', startedAt: new Date(now - 1_000), completedAt: new Date(now - 1_000), safetyVerdict: 'HALAL' },
        { status: 'FAILED', startedAt: new Date(now - 2_000), completedAt: new Date(now - 2_000), safetyVerdict: 'HALAL' },
      ],
    });
    assert.equal(evaluation.state, 'FAILED');
    assert.equal(evaluation.failureCount, 3);
  });

  it('a safety rejection blocks the agent', () => {
    const now = Date.now();
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      recentRuns: [
        { status: 'BLOCKED', startedAt: new Date(now), completedAt: new Date(now), safetyVerdict: 'NOT_ALLOWED' },
      ],
    });
    assert.equal(evaluation.state, 'BLOCKED');
    assert.match(evaluation.reasons[0], /safety rejection/);
  });

  it('degraded-only history with no successes is DEGRADED', () => {
    const now = Date.now();
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      recentRuns: [
        { status: 'DEGRADED', startedAt: new Date(now), completedAt: new Date(now), safetyVerdict: 'HALAL' },
      ],
    });
    assert.equal(evaluation.state, 'DEGRADED');
  });

  it('normal successes are HEALTHY', () => {
    const now = Date.now();
    const evaluation = evaluateAgentHealth({
      ...baseInput,
      recentRuns: [
        { status: 'SUCCEEDED', startedAt: new Date(now), completedAt: new Date(now), safetyVerdict: 'HALAL' },
        { status: 'SUCCEEDED', startedAt: new Date(now - 1_000), completedAt: new Date(now - 1_000), safetyVerdict: 'HALAL' },
      ],
    });
    assert.equal(evaluation.state, 'HEALTHY');
    assert.equal(evaluation.successCount, 2);
  });
});

describe('human review categories', () => {
  it('category guard accepts exactly the defined categories', () => {
    assert.equal(isHumanReviewCategory('PUBLICATION'), true);
    assert.equal(isHumanReviewCategory('SPENDING'), true);
    assert.equal(isHumanReviewCategory('SAFETY_REVIEW'), true);
    assert.equal(isHumanReviewCategory('MADE_UP'), false);
    assert.ok(HUMAN_REVIEW_CATEGORIES.length >= 8);
  });
});
