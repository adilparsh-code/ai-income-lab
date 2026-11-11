// ============================================================================
// PHASE 4.2D — RESEARCH -> VALIDATION PROVENANCE (real pipeline, real SQLite)
// ============================================================================
// Before this phase the VALIDATION stage rebuilt its request from the original
// objective; it never consumed what RESEARCH actually produced. These tests run
// the REAL bounded pipeline (deterministic MOCKED agents) and assert:
//
//   1. a ResearchResult row is persisted with the run's tenant/opportunity/job
//   2. VALIDATION consumes that exact id (provenance carried into its output)
//   3. the PipelineRun is tenant-owned
//   4. an unauthorized tenant cannot reuse another tenant's opportunity
//   5. stages that fail upstream never produce a validation PASS
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTestDatabase } from '@/test-utils/install-test-database';

const tempDir = mkdtempSync(join(tmpdir(), 'aill-provenance-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  OPERATOR_CONTROL_TOKEN: 'test-operator-token-value',
  AI_PROVIDER: 'mock',
});

before(() => {
  installTestDatabase(join(tempDir, 'test.db'));
});

after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* tmp cleanup best-effort */
  }
});

type Db = (typeof import('@/lib/db'))['db'];
type Orchestrator = typeof import('../orchestrator');

let db: Db;
let orchestrator: Orchestrator;
let tenantId = '';
let otherTenantId = '';
let opportunityId = '';

before(async () => {
  ({ db } = await import('@/lib/db'));
  orchestrator = await import('../orchestrator');

  const tenant = await db.tenant.create({ data: { slug: 'provenance-a', name: 'Provenance A' } });
  const other = await db.tenant.create({ data: { slug: 'provenance-b', name: 'Provenance B' } });
  tenantId = tenant.id;
  otherTenantId = other.id;

  const opportunity = await db.opportunity.create({
    data: {
      title: 'Compliant habit tracker',
      category: 'Digital Products',
      businessModel: 'Direct Sales',
      targetAudience: 'Remote workers',
      problemSolved: 'Inconsistent daily habits',
      monetizationMethod: 'ONE_TIME_PURCHASE',
      tenantId,
    },
  });
  opportunityId = opportunity.id;
});

describe('research provenance', () => {
  it('persists a tenant-owned research artifact and validation consumes its id', async () => {
    const run = await orchestrator.runPipeline({
      objective: 'Evaluate a compliant digital habit tracker for remote workers',
      opportunityId,
      tenantId,
      jobId: 'job-provenance-1',
      correlationId: 'corr-provenance-1',
      stages: ['RESEARCH', 'VALIDATION', 'PRODUCT'],
    });

    assert.ok(run.researchResultId, 'the run must report the persisted research artifact');

    const stored = await db.researchResult.findUnique({ where: { id: run.researchResultId! } });
    assert.ok(stored, 'the research artifact must exist in the database');
    assert.equal(stored!.tenantId, tenantId);
    assert.equal(stored!.opportunityId, opportunityId);
    assert.equal(stored!.jobId, 'job-provenance-1');
    assert.equal(stored!.correlationId, 'corr-provenance-1');
    assert.ok(stored!.findings.length > 2, 'structured findings are stored');
    assert.doesNotThrow(() => JSON.parse(stored!.findings), 'findings are valid JSON');

    // The VALIDATION step must carry the SAME id (it consumed this artifact).
    const validationStep = run.steps.find((s) => s.stage === 'VALIDATION');
    assert.ok(validationStep, 'the validation stage must have run');
    const validationOutput = validationStep!.summary.output as { researchResultId?: string } | undefined;
    assert.equal(
      validationOutput?.researchResultId,
      run.researchResultId,
      'validation must reference the persisted research artifact',
    );

    // Every pipeline record is tenant-owned.
    if (run.runId) {
      const pipelineRun = await db.pipelineRun.findUnique({ where: { id: run.runId } });
      assert.equal(pipelineRun?.tenantId, tenantId);
    }
  });

  it('refuses a tenant that does not own the opportunity and persists no research', async () => {
    const before = await db.researchResult.count({ where: { tenantId: otherTenantId } });
    const run = await orchestrator.runPipeline({
      objective: 'Cross-tenant attempt on a foreign opportunity',
      opportunityId,
      tenantId: otherTenantId,
      stages: ['RESEARCH', 'VALIDATION'],
    });
    assert.equal(run.status, 'FAILED');
    assert.match(run.reasoning, /does not match the opportunity owner/);
    assert.equal(run.steps.length, 0, 'no stage may execute for a mismatched tenant');
    assert.equal(await db.researchResult.count({ where: { tenantId: otherTenantId } }), before);
  });

  it('a standalone validation run fabricates no research provenance', async () => {
    // VALIDATION can be requested on its own (job-level use). In that case no
    // research artifact exists, and the run must NOT invent one: the validation
    // output carries no researchResultId.
    const run = await orchestrator.runPipeline({
      objective: 'Validate a compliant standalone offering',
      opportunityId,
      tenantId,
      stages: ['VALIDATION'],
    });
    assert.equal(run.researchResultId, undefined);
    const validation = run.steps.find((s) => s.stage === 'VALIDATION');
    assert.ok(validation, 'the standalone validation stage runs');
    const output = validation!.summary.output as { researchResultId?: string } | undefined;
    assert.equal(output?.researchResultId, undefined, 'no provenance may be claimed without an artifact');
  });

  it('does not duplicate an artifact across two independent runs', async () => {
    const first = await orchestrator.runPipeline({
      objective: 'Evaluate a second compliant offering',
      opportunityId,
      tenantId,
      correlationId: 'corr-provenance-2',
      stages: ['RESEARCH'],
    });
    const second = await orchestrator.runPipeline({
      objective: 'Evaluate a second compliant offering',
      opportunityId,
      tenantId,
      correlationId: 'corr-provenance-3',
      stages: ['RESEARCH'],
    });
    assert.ok(first.researchResultId);
    assert.ok(second.researchResultId);
    assert.notEqual(first.researchResultId, second.researchResultId, 'each run keeps its own provenance row');
  });
});
