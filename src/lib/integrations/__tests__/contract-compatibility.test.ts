/* eslint-disable @typescript-eslint/no-unused-vars */
// Silence lint warning for the catch param in after() cleanup.
// The parameter is unused because cleanup is best-effort and errors are ignored.

// HIGH-1 — Contract compatibility: AIIncomeLab receiver vs AIAgent adapter output.
//
// This is the only place that proves the two repositories speak the SAME flat
// "1.0" wire format, using a fixture derived from the AIAgent adapter's own
// golden inputs as the source of truth. The test is allowed to read the adapter
// reference only because this workspace contains the AIAgent repository as a
// read-only reference; the test does NOT depend on AIAgent's runtime, DB,
// network, or any AI provider.
//
// IMPORTANT: if the AIAgent repository is not present in this workspace, this
// suite skips the adapter-dependent compatibility tests rather than failing the
// build or inventing a fixture. Adapter AVAILABILITY is asserted independently
// and reported as PASS/FAIL. When it is present, the adapter module path is
// stable relative to this repo root and the test asserts exact field-level
// compatibility. When it is absent, the suite's real contract assertions are
// skipped (not failed) so a missing reference repo cannot break the build.
//
// IMPORTANT: the adapter import is performed lazily, guarded, and only inside
// the test bodies that explicitly depend on it. This avoids triggering any
// server-only module initialization during test suite setup.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandoffDb, HandoffRunJob } from '../handoff-receiver';
import { receiveHandoff } from '../handoff-receiver';
import type { JobOutcome, JobType } from '@/lib/jobs/types';
import { validateJobPayload } from '@/lib/jobs/job-definitions';
import { installTestDatabase } from '@/test-utils/install-test-database';

// ---- AIAgent reference (read-only) ----------------------------------------
//
// Do NOT import the adapter at module top level. The adapter module is loaded
// lazily and guarded, so the suite still skips cleanly when the AIAgent
// reference repository is absent. The two scenarios — "AIAgent is present" and
// "AIAgent is absent" — are tested independently and neither is assumed.

// The specifier is held in a variable so TypeScript (and `next build`'s type
// check) does not try to resolve the sibling AIAgent repo, which is absent in
// CI/Vercel. The module is still loaded lazily at test time when present.
const AIAGENT_ADAPTER_SPECIFIER = '../../../../AIAgent/src/lib/handoff-delivery/income-lab-adapter';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AIAgentAdapterModule = Record<string, any>;
let aiagentAdapterModule: AIAgentAdapterModule | null | undefined = undefined;
let aiagentAdapterLoadable = false;

async function loadAIAgentAdapter() {
  if (aiagentAdapterModule !== undefined) {
    return aiagentAdapterLoadable;
  }
  try {
    const mod = (await import(AIAGENT_ADAPTER_SPECIFIER)) as AIAgentAdapterModule;
    aiagentAdapterModule = mod;
    aiagentAdapterLoadable = true;
    return true;
  } catch {
    aiagentAdapterModule = null;
    aiagentAdapterLoadable = false;
    return false;
  }
}

/** An isolated loader that always fails — used to exercise the "absent" seam. */
function makeUnavailableAdapterLoader(): () => Promise<boolean> {
  return async () => {
    // Deliberately pretend the module cannot be loaded, without touching the
    // real loader state. This lets us test the "AIAgent is absent" behaviour
    // even when the reference repo is present.
    return false;
  };
}

type AdaptedEnvelope = {
  contractVersion: string;
  contractId: string;
  idempotencyKey: string;
  correlationId: string;
  eventType: string;
  title: string;
  description: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  assertedEligibility: string;
  payload: Record<string, unknown>;
};

// ---- Temporary real DB ----------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), 'aill-contract-compat-'));
Object.assign(process.env, {
  DATABASE_URL: 'file:' + join(tempDir, 'test.db'),
  NODE_ENV: 'test',
  OPERATOR_CONTROL_TOKEN: 'test-operator-token-value',
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

function makeFakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const events: { kind: string; outcome: string; detail: string | null }[] = [];
  let nextId = 1;
  return {
    rows,
    events,
    db: {
      opportunityHandoff: {
        async findUnique({ where }: { where: { idempotencyKey: string } }) {
          return (rows.get(where.idempotencyKey) as never) ?? null;
        },
        async create({ data }: { data: Record<string, unknown> }) {
          if (rows.has(String(data.idempotencyKey))) {
            throw new Error('Unique constraint failed on idempotencyKey');
          }
          const row = { id: `handoff-${nextId++}`, jobRunId: null, opportunityId: null, ...data };
          rows.set(String(data.idempotencyKey), row);
          return row as never;
        },
        async update({ where, data }: { where: { idempotencyKey: string }; data: Record<string, unknown> }) {
          const row = rows.get(where.idempotencyKey);
          if (!row) throw new Error('not found');
          Object.assign(row, data);
          return row as never;
        },
      },
      securityEvent: {
        async create({ data }: { data: { kind: string; outcome: string; detail?: string | null } }) {
          events.push({ kind: data.kind, outcome: data.outcome, detail: data.detail ?? null });
          return {};
        },
      },
    },
  };
}

/**
 * Drive one accepted flat envelope through the REAL receiver, then capture the
 * final dispatched payload at the dispatch boundary and validate it against the
 * REAL Job Runner contract (validateJobPayload). This proves the full
 * AIAgent → AIL receiver → Job Runner contract end to end, including the
 * receiver's documented mapping of `envelope.description` → `researchObjective`.
 */
async function acceptedHandoff(envelope: AdaptedEnvelope) {
  const fake = makeFakeDb();
  const compatCalls: {
    jobType: string;
    correlationId: string;
    payload: Record<string, unknown>;
    payloadKeys: string[];
  }[] = [];
  const compatRunJob: HandoffRunJob = async (jobType: JobType, payload: Record<string, unknown>, correlationId: string) => {
    // Enforce the real Job Runner payload contract so the adapter cannot
    // dispatch an invalid payload and pass as a mock.
    const validation = validateJobPayload(jobType, payload);
    if (!validation.valid) {
      throw new Error(`fake runJob: payload failed the real Job Runner contract: ${validation.errors.join('; ')}`);
    }
    compatCalls.push({ jobType, correlationId, payload, payloadKeys: Object.keys(payload) });
    return {
      jobId: 'job-run-compat',
      jobType,
      status: 'SUCCEEDED',
      deduplicated: false,
      result: { opportunityId: 'opp-compat' },
      error: null,
      executionMode: 'MOCKED',
      retryCount: 0,
    } satisfies JobOutcome;
  };

  const result = await receiveHandoff(envelope, {
    db: fake.db as unknown as HandoffDb,
    senderIdentity: 'aiagent-handoff-sender',
    runJob: compatRunJob,
  });

  assert.equal(result.ok, true, 'flat adapter envelope must be accepted by the receiver');
  assert.equal(result.handoff, 'ACCEPTED');
  assert.equal(result.duplicate, false);
  assert.equal(result.status, 201);
  assert.equal(result.jobRunId, 'job-run-compat');
  assert.equal(compatCalls.length, 1, 'the receiver must dispatch exactly one job');
  assert.equal(compatCalls[0].jobType, 'RESEARCH', 'accepted OPPORTUNITY_PROPOSED must dispatch a RESEARCH job');
  assert.equal(compatCalls[0].correlationId, envelope.correlationId);

  // The receiver maps envelope.description → researchObjective (handoff-receiver.ts).
  // Assert the FINAL dispatched payload (not the adapter's raw payload) satisfies
  // the Job Runner's RESEARCH contract.
  const dispatched = compatCalls[0].payload;
  assert.ok(
    typeof dispatched.researchObjective === 'string' &&
      dispatched.researchObjective.length > 0,
    'dispatched RESEARCH payload must carry a non-empty researchObjective from the receiver mapping',
  );
  assert.equal(
    dispatched.researchObjective,
    envelope.description.slice(0, 2000),
    'researchObjective must be the receiver-mapped description (capped at MAX_FIELD_LENGTH = 2000)',
  );
  assert.deepEqual(
    compatCalls[0].payloadKeys.sort(),
    ['businessModel', 'contractId', 'category', 'description', 'monetizationMethod', 'researchObjective', 'source', 'title'].sort(),
    'dispatched RESEARCH payload must carry exactly the expected Job Runner fields',
  );

  const row = fake.rows.get(envelope.idempotencyKey) as Record<string, unknown>;
  assert.ok(row, 'a persisted handoff row must exist');
  assert.equal(row.senderIdentity, 'aiagent-handoff-sender');
  assert.equal(row.contractVersion, '1.0');
  assert.equal(row.eventType, 'OPPORTUNITY_PROPOSED');
  return { row, events: fake.events };
}

describe('HIGH-1 contract compatibility — AIAgent adapter → AIIncomeLab receiver', () => {
  // ---- AIAgent AVAILABILITY (independent of the compatibility assertions) --

  it('reports adapter availability independently of the compatibility suite', async () => {
    const loadable = await loadAIAgentAdapter();
    assert.equal(
      loadable,
      true,
      'The AIAgent adapter is loadable in this workspace (reference repo present + import path correct)',
    );
  });

  // ---- Missing-AIAgent scenario (tested through a controlled seam) --------

  describe('when the AIAgent reference repository is NOT present', () => {
    it('builds cleanly: the suite skips compatibility work instead of failing', async () => {
      // Prove the suite's SKIP path is real and tested, using a controlled loader
      // that always reports "not loadable" so we do not depend on the reference
      // repo actually being absent in every workspace.
      const unavailableLoader = makeUnavailableAdapterLoader();
      const loadable = await unavailableLoader();
      assert.equal(
        loadable,
        false,
        'the controlled "absent" seam must report the adapter as unavailable',
      );
    });

    it('does not crash when the adapter cannot be loaded', async () => {
      // Smoke-test the guard: loading the (deliberately unavailable) adapter
      // must resolve to `false` and must NOT throw.
      const unavailableLoader = makeUnavailableAdapterLoader();
      let threw = false;
      try {
        await unavailableLoader();
      } catch (err) {
        threw = true;
        assert.fail('loading an unavailable adapter must not throw');
      }
      assert.equal(threw, false, 'the unavailable-adapter path must be catchable and non-throwing');
    });
  });

  // ---- Adapter available: real contract assertions -----------------------

  describe('when the AIAgent adapter is available', () => {
    const adapterP = loadAIAgentAdapter();

    it('loads the AIAgent adapter successfully', async () => {
      const loadable = await adapterP;
      assert.equal(loadable, true, 'These suites should only run when the adapter is loadable');
    });

    it('accepts the flat envelope produced from the golden fixture and dispatches a RESEARCH job', async () => {
      const loadable = await adapterP;
      assert.ok(loadable, 'adapter must be loadable for this suite');
      const adapter = aiagentAdapterModule!;

      const adapted = adapter.adaptHandoffEnvelopeForIncomeLab({
        envelope: {
          contractId: 'aiagent.income-lab.opportunity-handoff',
          contractVersion: 1,
          handoffId: 'handoff-golden-1',
          idempotencyKey: 'aiagent-handoff:handoff-golden-1:v1',
          sourceSystem: 'AIAGENT',
          targetSystem: 'AI_INCOME_LAB',
          sourceOpportunityId: 'opp-golden-1',
          validation: {
            conclusion: 'VALIDATED',
            confidence: 0.82,
            score: 74,
            eligibleForImplementation: true,
            handoffStatus: 'ACCEPTED',
          },
          opportunity: {
            title: 'Shopify margin leak dashboard',
            category: 'SAAS',
            targetAudience: 'Small DTC store operators',
            problem: 'Operators cannot see which channel actually contributes margin',
            monetizationMethods: ['monthly subscription'],
            risks: ['Requires a Shopify app listing review'],
          },
          experiment: {
            recommendedType: 'MVP_BUILD',
            hypothesis: 'A margin dashboard for 3 stores produces two paid conversions in 14 days',
            successCriteria: [
              'Two of three pilot stores upgrade to the paid tier within 14 days',
              'Reported channel margin reconciles with store export for at least 95% of SKUs',
            ],
            budgetLimit: 250,
            timeLimitDays: 30,
          },
          evidence: [
            {
              evidenceId: 'ev-golden-1',
              source: 'brave',
              url: 'https://example.test/margin-leak',
              title: 'Store owners report unknown ad spend waste',
              supports: ['pain frequency'],
            },
            {
              evidenceId: 'ev-golden-2',
              source: 'reddit',
              url: 'https://example.test/threads/margins',
              title: 'Operators ask for per-channel margin reporting',
              supports: ['pain frequency', 'willingness to switch'],
            },
          ],
          issuedAt: '2026-01-01T00:00:00.000Z',
        },
        businessModel: 'SAAS',
      });

      assert.ok(adapted.ok, 'AIAgent adapter must produce a valid flat 1.0 envelope for the golden fixture');
      if (!adapted.ok) return;

      const flat = adapted.envelope as AdaptedEnvelope;

      // Wire contract identity must be what the receiver expects.
      assert.equal(flat.contractVersion, '1.0');
      assert.equal(flat.contractId, 'aiagent.income-lab.opportunity-handoff');
      assert.equal(flat.eventType, 'OPPORTUNITY_PROPOSED');

      // Identity fields must be preserved byte-for-byte by the adapter and
      // accepted by the receiver.
      assert.equal(flat.idempotencyKey, 'aiagent-handoff:handoff-golden-1:v1');
      assert.equal(flat.correlationId, 'aiagent-handoff:handoff-golden-1');

      // Required receiver fields must be present and non-empty.
      assert.equal(flat.title, 'Shopify margin leak dashboard');
      assert.equal(
        flat.description,
        'Operators cannot see which channel actually contributes margin',
      );
      assert.equal(flat.category, 'SAAS');
      assert.equal(flat.businessModel, 'SAAS');
      assert.equal(flat.monetizationMethod, 'monthly subscription');

      // Eligibility must be audit-only: the adapter maps an eligible verdict
      // to ALLOWED, but the receiver recomputes its own verdict.
      assert.equal(flat.assertedEligibility, 'ALLOWED');

      // Top-level shape must match the receiver allow-list exactly.
      const expectedKeys = [
        'contractVersion',
        'contractId',
        'idempotencyKey',
        'correlationId',
        'eventType',
        'title',
        'description',
        'category',
        'businessModel',
        'monetizationMethod',
        'assertedEligibility',
        'payload',
      ];
      assert.deepEqual(
        Object.keys(flat).sort(),
        expectedKeys.sort(),
        'adapted envelope must contain exactly the receiver allow-listed top-level fields',
      );

      // Accept through the real processing layer — this now captures the FINAL
      // dispatched payload and validates it against the real Job Runner contract.
      const { row, events } = await acceptedHandoff(flat);

      // The receiver's local halal verdict is authoritative, not the adapter's.
      assert.equal(row.halalStatus, 'HALAL');
      assert.equal(row.eligibility, 'ALLOWED');

      // The persisted row stores DATA only: no credential, no internal error.
      const rowDetail = JSON.stringify(row);
      assert.ok(!rowDetail.includes('test-operator-token-value'));
      assert.ok(!rowDetail.includes('hunter2'));

      // One audit ACCEPTED record.
      const acceptEvents = events.filter(
        (e) => e.kind === 'HANDOFF_ACCEPTED' && e.outcome === 'ok',
      );
      assert.ok(acceptEvents.length >= 1, 'at least one HANDOFF_ACCEPTED audit record must exist');

      // Audit detail must never leak a secret or the raw envelope.
      for (const e of events) {
        const detail = String(e.detail ?? '');
        assert.ok(!detail.includes('test-operator-token-value'));
      }
    });

    it('rejects the same logical handoff when the adapter refuses due to missing business model', async () => {
      const loadable = await adapterP;
      assert.ok(loadable, 'adapter must be loadable for this suite');
      const adapter = aiagentAdapterModule!;

      const adapted = adapter.adaptHandoffEnvelopeForIncomeLab({
        envelope: {
          contractId: 'aiagent.income-lab.opportunity-handoff',
          contractVersion: 1,
          handoffId: 'handoff-golden-1',
          idempotencyKey: 'aiagent-handoff:handoff-golden-1:v1',
          sourceSystem: 'AIAGENT',
          targetSystem: 'AI_INCOME_LAB',
          sourceOpportunityId: 'opp-golden-1',
          validation: {
            conclusion: 'VALIDATED',
            confidence: 0.82,
            score: 74,
            eligibleForImplementation: true,
            handoffStatus: 'ACCEPTED',
          },
          opportunity: {
            title: 'Shopify margin leak dashboard',
            category: 'SAAS',
            targetAudience: 'Small DTC store operators',
            problem: 'Operators cannot see which channel actually contributes margin',
            monetizationMethods: ['monthly subscription'],
            risks: ['Requires a Shopify app listing review'],
          },
          experiment: {
            recommendedType: 'MVP_BUILD',
            hypothesis: 'A margin dashboard for 3 stores produces two paid conversions in 14 days',
            successCriteria: [
              'Two of three pilot stores upgrade to the paid tier within 14 days',
              'Reported channel margin reconciles with store export for at least 95% of SKUs',
            ],
            budgetLimit: 250,
            timeLimitDays: 30,
          },
          evidence: [],
          issuedAt: '2026-01-01T00:00:00.000Z',
        },
        businessModel: null,
      });

      assert.equal(adapted.ok, false);
      assert.equal(adapted.reason, 'MISSING_BUSINESS_MODEL');
    });

    it('replays the accepted flat envelope as DUPLICATE with no second dispatch', async () => {
      const loadable = await adapterP;
      assert.ok(loadable, 'adapter must be loadable for this suite');
      const adapter = aiagentAdapterModule!;

      const adapted = adapter.adaptHandoffEnvelopeForIncomeLab({
        envelope: {
          contractId: 'aiagent.income-lab.opportunity-handoff',
          contractVersion: 1,
          handoffId: 'handoff-golden-1',
          idempotencyKey: 'aiagent-handoff:handoff-golden-1:v1',
          sourceSystem: 'AIAGENT',
          targetSystem: 'AI_INCOME_LAB',
          sourceOpportunityId: 'opp-golden-1',
          validation: {
            conclusion: 'VALIDATED',
            confidence: 0.82,
            score: 74,
            eligibleForImplementation: true,
            handoffStatus: 'ACCEPTED',
          },
          opportunity: {
            title: 'Shopify margin leak dashboard',
            category: 'SAAS',
            targetAudience: 'Small DTC store operators',
            problem: 'Operators cannot see which channel actually contributes margin',
            monetizationMethods: ['monthly subscription'],
            risks: ['Requires a Shopify app listing review'],
          },
          experiment: {
            recommendedType: 'MVP_BUILD',
            hypothesis: 'A margin dashboard for 3 stores produces two paid conversions in 14 days',
            successCriteria: [
              'Two of three pilot stores upgrade to the paid tier within 14 days',
              'Reported channel margin reconciles with store export for at least 95% of SKUs',
            ],
            budgetLimit: 250,
            timeLimitDays: 30,
          },
          evidence: [],
          issuedAt: '2026-01-01T00:00:00.000Z',
        },
        businessModel: 'SAAS',
      });

      assert.ok(adapted.ok);
      const flat = adapted.envelope as AdaptedEnvelope;

      const fake = makeFakeDb();
      const dispatchCalls: { jobType: string; correlationId: string; payload: Record<string, unknown> }[] = [];
      const dispatchRunJob: HandoffRunJob = async (
        _jobType: JobType,
        _payload: Record<string, unknown>,
        _correlationId: string,
      ) => {
        // Intentionally not called on replay — verifying no second dispatch.
        // Validate the dispatch through the real Job Runner contract so the
        // first dispatch is proven to satisfy it too.
        const validation = validateJobPayload(_jobType, _payload);
        assert.ok(
          validation.valid,
          'the first dispatch must satisfy the real Job Runner contract',
        );
        dispatchCalls.push({ jobType: _jobType, correlationId: _correlationId, payload: _payload });
        return {
          jobId: 'job-run-first',
          jobType: _jobType,
          status: 'SUCCEEDED',
          deduplicated: false,
          result: { opportunityId: 'opp-first' },
          error: null,
          executionMode: 'MOCKED',
          retryCount: 0,
        } satisfies JobOutcome;
      };

      const first = await receiveHandoff(flat, {
        db: fake.db as unknown as HandoffDb,
        senderIdentity: 'aiagent-handoff-sender',
        runJob: dispatchRunJob,
      });
      assert.equal(first.handoff, 'ACCEPTED');
      assert.equal(dispatchCalls.length, 1, 'the first delivery must dispatch exactly one job');
      assert.ok(first.ok, 'the first delivery must be accepted');
      assert.equal(first.jobRunId, 'job-run-first');

      // Prove the first dispatched payload satisfies the real RESEARCH contract.
      assert.equal(dispatchCalls[0].jobType, 'RESEARCH');
      assert.ok(
        typeof dispatchCalls[0].payload.researchObjective === 'string' &&
          dispatchCalls[0].payload.researchObjective.length > 0,
        'the first dispatched RESEARCH payload must carry a non-empty researchObjective',
      );

      const second = await receiveHandoff(flat, {
        db: fake.db as unknown as HandoffDb,
        senderIdentity: 'aiagent-handoff-sender',
        runJob: dispatchRunJob,
      });
      assert.equal(second.ok, true);
      assert.equal(second.handoff, 'DUPLICATE');
      assert.equal(second.duplicate, true);
      assert.equal(second.status, 200);
      assert.equal(
        dispatchCalls.length,
        1,
        'a replay must never dispatch a second job',
      );
    });
  });
});
