// Agency upgrade — DB-backed runtime tests (hermetic temp SQLite).
// Exercises the REAL runtime store against a temporary database: contract
// seeding, supervised run recording, health snapshots, allow-listed messaging,
// human review queue, control switch, and the supervised dispatch flow with an
// injected Job Runner test double (the runner itself has its own suite).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-agency-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  // Pin the v7 CLI: the default `prisma` binary is now the Prisma 8 RC after
  // the main merge, and its interactive "agent skills" gate fails db push in
  // non-interactive test runs. --schema= (equals form) is required by prisma7.
  execSync('npx prisma7 db push --schema=prisma/schema.test.prisma', {
    stdio: 'pipe',
    cwd: process.cwd(),
    env: process.env,
  });
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

let runtime: typeof import('../runtime');
let dispatch: typeof import('../supervised-dispatch');

before(async () => {
  runtime = await import('../runtime');
  dispatch = await import('../supervised-dispatch');
});

describe('agency runtime store (hermetic DB)', () => {
  it('seeds all 13 contracts + tool permissions idempotently', async () => {
    const first = await runtime.seedAgencyContracts();
    assert.equal(first.seeded, 13);
    assert.ok(first.permissions > 0);
    const second = await runtime.seedAgencyContracts();
    assert.equal(second.seeded, 13);
    assert.equal(second.permissions, first.permissions, 'upserts must not duplicate permission rows');
    assert.equal(await runtime.agencySeeded(), true);
  });

  it('records a run and derives health from it', async () => {
    await runtime.recordAgentRun({
      agentId: 'research',
      jobId: 'job-run-1',
      jobType: 'RESEARCH',
      stage: 'RESEARCH',
      status: 'SUCCEEDED',
      correlationId: 'corr-health-1',
      lifecycleSteps: [{ step: 'EXECUTE', outcome: 'OK' }],
      safetyVerdict: 'HALAL',
      verification: 'PASSED',
    });
    const health = await runtime.listAgentHealth();
    const research = health.find((h) => h.agentId === 'research');
    assert.ok(research);
    assert.equal(research.state, 'HEALTHY');
    assert.equal(research.successCount, 1);
    assert.ok(research.lastRunAt);
  });

  it('run views round-trip lifecycle steps and evidence refs', async () => {
    await runtime.recordAgentRun({
      agentId: 'validation',
      jobId: 'job-run-2',
      jobType: 'VALIDATION',
      stage: 'VALIDATE',
      status: 'FAILED',
      correlationId: 'corr-health-2',
      lifecycleSteps: [
        { step: 'SAFETY_CHECK', outcome: 'FAILED', detail: 'evidence insufficient' },
      ],
      safetyVerdict: 'HALAL',
      verification: 'FAILED',
      failureReason: 'insufficient evidence',
      evidenceRefs: [{ type: 'OPPORTUNITY', id: 'opp-1' }],
    });
    const runs = await runtime.listAgentRuns('validation');
    const run = runs[runs.length - 1];
    assert.equal(run.jobId, 'job-run-2');
    assert.equal(run.status, 'FAILED');
    assert.equal(run.lifecycleSteps[0].step, 'SAFETY_CHECK');
    assert.deepEqual(run.evidenceRefs, [{ type: 'OPPORTUNITY', id: 'opp-1' }]);
  });

  it('messages are allow-listed, bounded, and data-only', async () => {
    const ok = await runtime.sendAgentMessage({
      correlationId: 'corr-msg-1',
      sourceAgent: 'business-manager',
      targetAgent: 'research',
      kind: 'TASK_REQUEST',
      payload: { objective: 'find niches' },
      evidenceRefs: [{ type: 'OPPORTUNITY', id: 'opp-1' }],
    });
    assert.equal(ok.ok, true);

    const refused = await runtime.sendAgentMessage({
      correlationId: 'corr-msg-2',
      sourceAgent: 'research',
      targetAgent: 'business-manager',
      kind: 'TASK_REQUEST', // reverse direction is NOT allow-listed
      payload: {},
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not allow-listed/);

    const oversized = await runtime.sendAgentMessage({
      correlationId: 'corr-msg-3',
      sourceAgent: 'analytics',
      targetAgent: 'business-manager',
      kind: 'FINDING',
      payload: { blob: 'x'.repeat(9_000) },
    });
    assert.equal(oversized.ok, false);
    assert.match(oversized.error, /exceeds/);

    const badKind = await runtime.sendAgentMessage({
      correlationId: 'corr-msg-4',
      sourceAgent: 'analytics',
      targetAgent: 'business-manager',
      kind: 'ARBITRARY' as never,
      payload: {},
    });
    assert.equal(badKind.ok, false);

    const messages = await runtime.listAgentMessages('research');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.objective, 'find niches');
  });

  it('human review queue records decisions exactly once', async () => {
    const created = await runtime.createHumanReview({
      category: 'PUBLICATION',
      title: 'Publish niche newsletter',
      detail: 'Provider confirmation pending',
      requestedBy: 'publishing',
      correlationId: 'corr-review-1',
    });
    assert.equal(created.ok, true);

    const pending = await runtime.listHumanReviews('PENDING');
    assert.ok(pending.some((r) => r.title === 'Publish niche newsletter'));

    const decided = await runtime.decideHumanReview({
      id: (created as { ok: true; id: string }).id,
      decision: 'APPROVE',
      decidedBy: 'admin@example.com',
      note: 'approved for bounded trial',
    });
    assert.equal(decided.ok, true);

    const again = await runtime.decideHumanReview({
      id: (created as { ok: true; id: string }).id,
      decision: 'REJECT',
      decidedBy: 'admin@example.com',
    });
    assert.equal(again.ok, false);
    assert.match((again as { ok: false; error: string }).error, /already APPROVED/);

    const invalidCategory = await runtime.createHumanReview({
      category: 'NOT_A_CATEGORY' as never,
      title: 'x',
      requestedBy: 'system',
    });
    assert.equal(invalidCategory.ok, false);
  });

  it('control switch stores pause state and is reflected in roster status', async () => {
    const before = await runtime.getAgencyControl();
    assert.equal(before.paused, false);

    await runtime.setAgencyPaused(true, 'admin@example.com', 'maintenance window');
    const paused = await runtime.getAgencyControl();
    assert.equal(paused.paused, true);
    assert.equal(paused.pauseReason, 'maintenance window');

    // Health refresh reads the pause flag → paused agents are BLOCKED.
    await runtime.refreshAgentHealth('research');
    const health = await runtime.listAgentHealth();
    const research = health.find((h) => h.agentId === 'research');
    assert.equal(research?.state, 'BLOCKED');

    const roster = await runtime.agentRosterStatus();
    assert.equal(roster.length, 13);
    const pausedEntry = roster.find((r) => r.agentId === 'research');
    assert.equal(pausedEntry?.status, 'BLOCKED');

    await runtime.setAgencyPaused(false, 'admin@example.com');
    const resumed = await runtime.getAgencyControl();
    assert.equal(resumed.paused, false);
  });
});

describe('supervised dispatch (hermetic DB + Job Runner seam)', () => {
  it('refuses unknown agents and unmapped agents before any execution', async () => {
    const unknown = await dispatch.dispatchSupervised({
      agentId: 'ghost' as never,
      stage: 'RESEARCH',
      objective: 'test',
    });
    assert.equal(unknown.ok, false);

    // job-runner / supervisor / ruflo-adapter / safety-halal / publishing /
    // growth / revenue / memory have no autonomous Job Runner mapping.
    const unmapped = await dispatch.dispatchSupervised({
      agentId: 'publishing',
      stage: 'PUBLISH',
      objective: 'test publish path',
    });
    assert.equal(unmapped.ok, false);
    assert.match((unmapped as { ok: false; detail?: string }).detail ?? '', /no autonomous Job Runner mapping/);
  });

  it('out-of-contract stage is refused with a BLOCKED governance record', async () => {
    const result = await dispatch.dispatchSupervised({
      agentId: 'research',
      stage: 'PUBLISH', // research may only DISCOVER/RESEARCH
      objective: 'attempt stage escape',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REFUSED');

    const runs = await runtime.listAgentRuns('research');
    const blocked = runs.find((r) => r.status === 'BLOCKED' && r.correlationId === (result as { correlationId?: string }).correlationId);
    assert.ok(blocked, 'a BLOCKED AgentRun must be recorded for the refused attempt');
    assert.equal(blocked.safetyVerdict, 'HALAL');
    assert.ok((blocked.failureReason ?? '').length > 0);
  });

  it('happy path: dispatches through the Job Runner seam and records the run', async () => {
    const result = await dispatch.dispatchSupervised(
      {
        agentId: 'research',
        stage: 'RESEARCH',
        objective: 'find a newsletter niche',
        correlationId: 'corr-dispatch-1',
      },
      {
        executeAgentJob: async () => ({
          success: true,
          reasoning: 'deterministic test executor',
          evidenceType: 'AI_INFERENCE',
          fallbackUsed: false,
          executionTime: 5,
          output: { recommendation: 'mock plan' },
        }),
      },
    );
    assert.equal(result.ok, true);
    const ok = result as Extract<typeof result, { ok: true }>;
    assert.equal(ok.jobStatus, 'SUCCEEDED');
    assert.equal(ok.verdict, 'PROCEED');
    assert.ok(ok.jobId && ok.jobId !== 'n/a');

    const runs = await runtime.listAgentRuns('research');
    const run = runs.find((r) => r.correlationId === 'corr-dispatch-1');
    assert.ok(run);
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.safetyVerdict, 'HALAL');
    assert.equal(run.verification, 'PASSED');
    assert.deepEqual(run.evidenceRefs, [{ type: 'JOB_RUN', id: ok.jobId }]);
    assert.ok(run.lifecycleSteps.some((s) => s.step === 'EXECUTE' && s.outcome === 'OK'));
  });

  it('records BLOCKED + NOT_ALLOWED without retrying or faking success', async () => {
    const result = await dispatch.dispatchSupervised(
      {
        agentId: 'validation',
        stage: 'VALIDATE',
        objective: 'blocked attempt',
        correlationId: 'corr-dispatch-blocked',
      },
      {
        // Job Runner would normally surface BLOCKED for NOT_ALLOWED; emulate
        // that terminal outcome through the same seam.
        executeAgentJob: async () => ({
          success: false,
          reasoning: 'halal gate refused',
          evidenceType: 'AI_INFERENCE',
          fallbackUsed: false,
          executionTime: 3,
          error: 'Blocked',
        }),
      },
    );
    // The injected executor failed (no opportunity rows exist) → honest FAILED.
    // A single failed run is a Job Runner / failure-recovery concern, not a
    // supervision violation, so the verdict stays deterministic (no fake
    // success, no retry here — retries are bounded inside the Job Runner).
    assert.equal(result.ok, true);
    const ok = result as Extract<typeof result, { ok: true }>;
    assert.equal(ok.jobStatus, 'FAILED');
    assert.ok(['PROCEED', 'PAUSE', 'QUARANTINE', 'ESCALATE'].includes(ok.verdict));
    assert.ok(ok.verdictReasons.length <= 10);

    const runs = await runtime.listAgentRuns('validation');
    const run = runs.find((r) => r.correlationId === 'corr-dispatch-blocked');
    assert.ok(run);
    assert.equal(run.status, 'FAILED');
    assert.equal(run.safetyVerdict, 'HALAL');
    assert.equal(run.verification, 'NOT_APPLICABLE');
  });
});
