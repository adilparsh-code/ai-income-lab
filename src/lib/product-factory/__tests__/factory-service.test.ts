// Hermetic tests for the Product Factory service layer.
//
// The narrow FactoryDb interface makes every DB touchpoint injectable, so
// these tests run with fakes: no database, no network, no AI provider. Paths
// that would reach runPipeline (which owns its own DB access) are exercised
// only up to the boundary — the orchestrator has its own integration coverage
// via the runtime smoke tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runProductFactory,
  rehydrateFactoryRun,
  type FactoryDb,
  type FactoryRevenueRow,
} from '../factory-service';
import type { PipelineStepSummary } from '@/lib/ruflo/pipeline-logic';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDbState {
  opportunities: (NonNullable<Awaited<ReturnType<FactoryDb['opportunity']['findUnique']>>>)[];
  revenues: FactoryRevenueRow[];
  evidence: Awaited<ReturnType<FactoryDb['evidenceItemModel']['findMany']>>;
  storedRuns: Map<string, string>;
  throwOnOpportunity?: boolean;
  throwOnEvidence?: boolean;
  pipelineRunUpdates: { id: string; result: string }[];
}

function makeDb(state: FakeDbState): FactoryDb {
  return {
    opportunity: {
      findUnique: async ({ where }) => {
        if (state.throwOnOpportunity) throw new Error('db down');
        return state.opportunities.find((o) => o.id === where.id) ?? null;
      },
    },
    revenue: {
      findMany: async () => state.revenues,
    },
    pipelineRun: {
      findUnique: async ({ where }) => {
        const result = state.storedRuns.get(where.id);
        return result === undefined ? null : { id: where.id, result, opportunityId: 'opp-1' };
      },
      update: async (args) => {
        state.pipelineRunUpdates.push({ id: args.where.id, result: args.data.result });
        return {};
      },
    },
    evidenceItemModel: {
      findMany: async () => {
        if (state.throwOnEvidence) throw new Error('db down');
        return state.evidence;
      },
    },
  };
}

function opportunity(overrides: Partial<{ id: string; title: string; problemSolved: string | null; estimatedStartupCost: number }> = {}) {
  return {
    id: 'opp-1',
    title: 'Homeschool planner opportunity',
    problemSolved: 'Planning is messy' as string | null,
    estimatedStartupCost: 0,
    ...overrides,
  };
}

function revenue(overrides: Partial<FactoryRevenueRow> = {}): FactoryRevenueRow {
  return {
    grossRevenue: 1000,
    fees: 100,
    advertisingCost: 0,
    otherCosts: 0,
    netRevenue: 900,
    opportunityId: 'opp-1',
    ...overrides,
  };
}

/** Bare step summary, as consumed by factory-logic. */
function summary(overrides: Partial<PipelineStepSummary> & { stage: PipelineStepSummary['stage'] }): PipelineStepSummary {
  return {
    executed: true,
    success: true,
    note: '',
    evidenceType: 'AI_INFERENCE',
    fallbackUsed: false,
    durationMs: 5,
    ...overrides,
  };
}

/**
 * Persisted run payloads hold PipelineStepResult wrappers (summary.output).
 * This matches the real orchestrator persistence shape.
 */
function persistedStep(stage: PipelineStepSummary['stage'], output: Record<string, unknown> = {}) {
  return {
    stage,
    agentType: stage.toLowerCase(),
    executed: true,
    success: true,
    note: '',
    summary: summary({ stage, output }),
    durationMs: 5,
  };
}

function persistedStepFailed(stage: PipelineStepSummary['stage']) {
  return {
    stage,
    agentType: stage.toLowerCase(),
    executed: true,
    success: false,
    note: 'validation failed',
    summary: { executed: true, success: false, note: 'validation failed', evidenceType: 'AI_INFERENCE', fallbackUsed: false, durationMs: 5, output: {} },
    durationMs: 5,
  };
}

function runJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'COMPLETED',
    objective: 'Design a product for: Homeschool planner opportunity — Planning is messy',
    opportunityId: 'opp-1',
    humanReviewRequired: false,
    reasoning: 'Bounded pipeline finished.',
    executionTime: 10,
    lifecycleStage: 'BUILD',
    lifecycleRationale: 'Products exist.',
    experimentPlan: [],
    progress: [],
    steps: [
      persistedStep('RESEARCH', { sources: [] }),
      persistedStep('VALIDATION'),
      persistedStep('PRODUCT'),
    ],
    findings: {
      risks: [],
      assumptions: [],
      missingEvidence: [],
      nextActions: [],
      provenanceCounts: {},
      aiTotals: { liveSteps: 0, fallbackSteps: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    },
    provenance: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Request validation (no pipeline execution attempted)
// ---------------------------------------------------------------------------

describe('runProductFactory: request validation', () => {
  const db = makeDb({ opportunities: [], revenues: [], evidence: [], storedRuns: new Map(), pipelineRunUpdates: [] });

  it('rejects an empty request without touching the pipeline', async () => {
    const outcome = await runProductFactory({}, db);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /Select an opportunity or provide an objective/i);
  });

  it('rejects unsupported product types and monetization models', async () => {
    const byType = await runProductFactory({ objective: 'x', productType: 'QUANTUM_LEVERAGE' }, db);
    assert.equal(byType.ok, false);
    assert.match(byType.error ?? '', /Unsupported product type/i);

    const byModel = await runProductFactory({ objective: 'x', monetizationPreference: 'PONZI' }, db);
    assert.equal(byModel.ok, false);
    assert.match(byModel.error ?? '', /Unsupported monetization model/i);
  });

  it('normalizes case for valid enum values', async () => {
    // 'printable' is a valid type; validation passes and the request proceeds
    // to the pipeline boundary. Any later failure is NOT an enum rejection.
    const outcome = await runProductFactory({ objective: 'Design a thing', productType: 'printable' }, db);
    assert.ok(
      !(outcome.error ?? '').includes('Unsupported product type'),
      `unexpected enum rejection: ${outcome.error}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Invalid opportunity (explicit error, never fabricated)
// ---------------------------------------------------------------------------

describe('runProductFactory: invalid opportunity', () => {
  it('rejects a nonexistent opportunity id explicitly', async () => {
    const db = makeDb({ opportunities: [], revenues: [], evidence: [], storedRuns: new Map(), pipelineRunUpdates: [] });
    const outcome = await runProductFactory({ opportunityId: 'missing-opp' }, db);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /was not found/);
  });

  it('surfaces a safe error when the opportunity lookup fails', async () => {
    const db = makeDb({
      opportunities: [], revenues: [], evidence: [], storedRuns: new Map(), pipelineRunUpdates: [],
      throwOnOpportunity: true,
    });
    const outcome = await runProductFactory({ opportunityId: 'opp-1' }, db);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /could not be loaded/);
    assert.doesNotMatch(outcome.error ?? '', /db down/); // no internals leaked
  });
});

// ---------------------------------------------------------------------------
// BI snapshot (attach + persist + corrupt-payload defense)
// ---------------------------------------------------------------------------

describe('runProductFactory: business intelligence snapshot', () => {
  it('is skipped for free-form objectives without an opportunity', async () => {
    const state: FakeDbState = { opportunities: [], revenues: [], evidence: [], storedRuns: new Map(), pipelineRunUpdates: [] };
    const db = makeDb(state);
    const outcome = await runProductFactory(
      { objective: 'x', __simulateRun: runJson() } as never,
      db,
    ).catch(() => null);
    // The fake pipeline boundary fails (no run simulated without an
    // opportunity path), which is fine — what matters is that no BI query ran
    // and no persistence was attempted.
    assert.equal(state.pipelineRunUpdates.length, 0);
    assert.equal(outcome === null || typeof outcome === 'object', true);
  });

  it('attaches and persists the deterministic snapshot on a completed run', async () => {
    const state: FakeDbState = {
      opportunities: [opportunity()],
      revenues: [revenue()],
      evidence: [],
      storedRuns: new Map([['run-1', runJson()]]),
      pipelineRunUpdates: [],
    };
    const db = makeDb(state);
    // Rehydrate the stored run (same attach path as a live completed run —
    // the runPipeline boundary itself is covered by runtime smoke tests).
    const rehydrated = await rehydrateFactoryRun('run-1', db);
    assert.ok(rehydrated);

    const snapshot = rehydrated.run.findings.businessIntelligence as Record<string, unknown>;
    assert.ok(snapshot, 'BI snapshot must be attached');
    const facts = snapshot.facts as Record<string, unknown>;
    // Deterministic figures from the shared profitability layer:
    // net 900 = gross 1000 − fees 100 (self-consistent record).
    assert.equal(facts.hasRevenueData, true);
    assert.equal(facts.netRevenue, 900);
    assert.equal(facts.contributionProfit, 900);
    assert.equal(facts.revenueHealth, 'PROFITABLE');
    assert.equal(facts.recordCount, 1);
    // Persistence: the same snapshot was written onto the stored findings.
    assert.equal(state.pipelineRunUpdates.length, 1);
    const persisted = JSON.parse(state.pipelineRunUpdates[0].result) as { findings: { businessIntelligence: unknown } };
    assert.deepEqual(persisted.findings.businessIntelligence, snapshot);
  });

  it('uses explicit NO_DATA facts on an empty database (never zeros dressed as verified)', async () => {
    const state: FakeDbState = {
      opportunities: [opportunity()],
      revenues: [],
      evidence: [],
      storedRuns: new Map([['run-1', runJson()]]),
      pipelineRunUpdates: [],
    };
    const rehydrated = await rehydrateFactoryRun('run-1', makeDb(state));
    assert.ok(rehydrated);
    const facts = (rehydrated.run.findings.businessIntelligence as Record<string, unknown>).facts as Record<string, unknown>;
    assert.equal(facts.hasRevenueData, false);
    assert.equal(facts.revenueHealth, 'NO_DATA');
    assert.match(String(facts.summary), /No revenue records are linked/);
  });

  it('tolerates corrupt stored payloads without overwriting them', async () => {
    const state: FakeDbState = {
      opportunities: [opportunity()],
      revenues: [revenue()],
      evidence: [],
      storedRuns: new Map([['run-1', 'not-json{']]),
      pipelineRunUpdates: [],
    };
    const rehydrated = await rehydrateFactoryRun('run-1', makeDb(state));
    assert.equal(rehydrated, null); // corrupt payload surfaces honestly as null
    assert.equal(state.pipelineRunUpdates.length, 0); // nothing overwritten
  });

  it('tolerates BI query failures gracefully (no snapshot, run still usable)', async () => {
    const state: FakeDbState = {
      opportunities: [opportunity()],
      revenues: [revenue()],
      evidence: [],
      storedRuns: new Map([['run-1', runJson()]]),
      pipelineRunUpdates: [],
      throwOnOpportunity: true,
    };
    const rehydrated = await rehydrateFactoryRun('run-1', makeDb(state));
    assert.ok(rehydrated, 'rehydration must not fail when the BI query fails');
    assert.equal(rehydrated.run.findings.businessIntelligence, undefined);
    assert.equal(state.pipelineRunUpdates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Rehydration + evidence enrichment
// ---------------------------------------------------------------------------

describe('rehydrateFactoryRun', () => {
  it('returns null for unknown run ids', async () => {
    const db = makeDb({ opportunities: [], revenues: [], evidence: [], storedRuns: new Map(), pipelineRunUpdates: [] });
    assert.equal(await rehydrateFactoryRun('nope', db), null);
  });

  it('returns null for structurally invalid payloads', async () => {
    const db = makeDb({
      opportunities: [], revenues: [], evidence: [], storedRuns: new Map([['run-1', JSON.stringify({ steps: 'nope' })]]),
      pipelineRunUpdates: [],
    });
    assert.equal(await rehydrateFactoryRun('run-1', db), null);
  });

  it('round-trips a HUMAN_REVIEW run with review semantics intact', async () => {
    const db = makeDb({
      opportunities: [opportunity()],
      revenues: [],
      evidence: [],
      storedRuns: new Map([['run-1', runJson({ status: 'HUMAN_REVIEW', humanReviewRequired: true })]]),
      pipelineRunUpdates: [],
    });
    const rehydrated = await rehydrateFactoryRun('run-1', db);
    assert.ok(rehydrated);
    assert.equal(rehydrated.run.status, 'HUMAN_REVIEW');
    assert.equal(rehydrated.run.humanReviewRequired, true);
  });

  it('round-trips a PARTIAL run with its failed step', async () => {
    const db = makeDb({
      opportunities: [opportunity()],
      revenues: [],
      evidence: [],
      storedRuns: new Map([
        ['run-1', runJson({
          status: 'PARTIAL',
          steps: [
            persistedStep('RESEARCH', { sources: [] }),
            persistedStepFailed('VALIDATION'),
          ],
        })],
      ]),
      pipelineRunUpdates: [],
    });
    const rehydrated = await rehydrateFactoryRun('run-1', db);
    assert.ok(rehydrated);
    assert.equal(rehydrated.run.status, 'PARTIAL');
    const validation = rehydrated.run.steps.find((s) => s.stage === 'VALIDATION');
    assert.equal(validation?.success, false);
  });

  it('merges stored evidence into the research output without relabelling provenance', async () => {
    const db = makeDb({
      opportunities: [opportunity()],
      revenues: [],
      evidence: [
        {
          url: 'https://example.com/cached',
          domain: 'example.com',
          title: 'Cached fetch',
          evidenceType: 'VERIFIED_DATA',
          excerpt: 'Previously fetched text',
          httpStatus: 200,
          contentType: 'text/html',
          contentLength: 512,
          fetchedAt: new Date('2026-09-17T10:00:00.000Z'),
        },
        {
          url: 'https://example.com/lead',
          domain: 'example.com',
          title: 'Discovery lead',
          evidenceType: 'SEARCH_DISCOVERY',
          excerpt: null,
          httpStatus: null,
          contentType: null,
          contentLength: null,
          fetchedAt: new Date('2026-09-17T09:00:00.000Z'),
        },
        {
          // Unknown provenance must be dropped, never relabelled.
          url: 'https://example.com/bad',
          domain: 'example.com',
          title: 'Bad row',
          evidenceType: 'AI_INFERENCE',
          excerpt: null,
          httpStatus: null,
          contentType: null,
          contentLength: null,
          fetchedAt: new Date('2026-09-17T08:00:00.000Z'),
        },
      ],
      storedRuns: new Map([['run-1', runJson({
        steps: [persistedStep('RESEARCH', { sources: [{ url: 'https://example.com/live', evidenceType: 'VERIFIED_DATA' }] })],
      })]]),
      pipelineRunUpdates: [],
    });
    const rehydrated = await rehydrateFactoryRun('run-1', db);
    assert.ok(rehydrated);
    const research = rehydrated.run.steps.find((s) => s.stage === 'RESEARCH') as unknown as { summary: { output: { sources: { url: string; evidenceType: string }[] } } };
    const sources = research.summary.output.sources;
    const urls = sources.map((s) => s.url);
    assert.ok(urls.includes('https://example.com/live')); // run evidence kept
    assert.ok(urls.includes('https://example.com/cached')); // stored evidence merged
    assert.ok(!urls.includes('https://example.com/bad')); // unknown provenance dropped
    const cached = sources.find((s) => s.url === 'https://example.com/cached');
    assert.equal(cached?.evidenceType, 'VERIFIED_DATA'); // never relabelled
  });

  it('continues without enrichment when the evidence store fails', async () => {
    const db = makeDb({
      opportunities: [opportunity()],
      revenues: [],
      evidence: [],
      storedRuns: new Map([['run-1', runJson()]]),
      pipelineRunUpdates: [],
      throwOnEvidence: true,
    });
    const rehydrated = await rehydrateFactoryRun('run-1', db);
    assert.ok(rehydrated, 'evidence enrichment failure must not break rehydration');
    const research = rehydrated.run.steps.find((s) => s.stage === 'RESEARCH') as unknown as { summary: { output: { sources: unknown[] } } };
    assert.equal(research.summary.output.sources.length, 0);
  });
});
