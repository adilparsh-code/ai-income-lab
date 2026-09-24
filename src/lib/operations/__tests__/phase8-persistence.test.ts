// Phase 8 — hermetic persistence coverage for durable missions and recovery ledger.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-phase8-persistence-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
});

before(async () => {
  const { execSync } = await import('node:child_process');
  execSync('npx prisma db push', { stdio: 'pipe', cwd: process.cwd(), env: process.env });
});

after(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const importMissions = () => import('../missions');
const importRecovery = () => import('../failure-recovery');
const importDb = () => import('@/lib/db');

describe('Phase 8 durable persistence', () => {
  it('persists a bounded mission and its human-safe lifecycle', async () => {
    const { createMission, startMission, completeMission, cancelMission } = await importMissions();
    const mission = await createMission({
      objective: 'Validate a new opportunity without external actions.',
      agentType: 'research',
      constraints: ['no publishing'],
      budget: 10,
      successCriteria: ['A recorded result exists'],
      correlationId: 'phase8-persist-mission',
    });
    assert.equal(mission.status, 'QUEUED');
    assert.deepEqual(mission.constraints, ['no publishing']);

    const running = await startMission(mission.id, new Date('2030-01-01T00:00:00.000Z'));
    assert.equal(running.status, 'RUNNING');
    assert.ok(running.startedAt);

    const completed = await completeMission(mission.id, true, 'criteria satisfied');
    assert.equal(completed.status, 'COMPLETED');
    assert.ok(completed.completedAt);

    const second = await createMission({
      objective: 'A mission that is cancelled before work runs.',
      agentType: 'validation',
      approvalRequired: true,
      correlationId: 'phase8-persist-cancel',
    });
    assert.equal(second.status, 'HUMAN_REVIEW');
    const cancelled = await cancelMission(second.id, 'operator cancelled');
    assert.equal(cancelled.status, 'CANCELLED');
    const stillCancelled = await completeMission(second.id, true, 'must not resurrect');
    assert.equal(stillCancelled.status, 'CANCELLED');
  });

  it('rejects unregistered agent types before persistence', async () => {
    const { createMission } = await importMissions();
    await assert.rejects(() => createMission({
      objective: 'This mission must not be persisted.',
      agentType: 'shell' as never,
      correlationId: 'phase8-invalid-agent',
    }), /agentType is not registered/);
  });

  it('persists a bounded failure recovery decision and dead-letter record', async () => {
    const { recordFailureRecovery, listDeadLetters } = await importRecovery();
    const { db } = await importDb();
    const opportunity = await db.opportunity.create({
      data: {
        title: 'Recovery persistence opportunity',
        category: 'EDUCATION',
        businessModel: 'DIGITAL_PRODUCT',
        targetAudience: 'testers',
        problemSolved: 'testing durable failure handling',
        monetizationMethod: 'ONE_TIME',
      },
    });
    try {
      const decision = await recordFailureRecovery({
        opportunityId: opportunity.id,
        error: { message: 'provider returned a permanent unsupported response' },
        retryCount: 0,
        correlationId: 'phase8-persist-recovery',
      });
      assert.equal(decision.category, 'PERMANENT');
      assert.equal(decision.state, 'DEAD_LETTER');
      assert.equal(decision.deadLetter, true);

      const rows = await listDeadLetters(10);
      assert.ok(rows.some((row) => row.correlationId === 'phase8-persist-recovery'));
    } finally {
      await db.failureRecovery.deleteMany({ where: { opportunityId: opportunity.id } });
      await db.opportunity.delete({ where: { id: opportunity.id } });
    }
  });
});
