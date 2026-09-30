// Phase 10.6 / 10.7 — Learning Observatory + Learning→Revenue attribution.
//
// MEMORY vs LEARNING distinction: rows record an OBSERVATION (what happened)
// plus an inference (hypothesis) with an explicit epistemic state. A hypothesis
// is never rendered as established truth. Attribution follows one deterministic
// rule: a learning links to a GrowthExperiment via experimentId; that
// experiment links to purchases via ProductEvent.experimentId; those purchase
// events sum to attributed revenue. No path ⇒ UNATTRIBUTED (never 0).

import { db } from '@/lib/db';
import type { LearningEpistemicState, LearningObservation, OutcomeLink } from './types';

/** Map the persisted result to the UI epistemic vocabulary (10.6). */
export function epistemicStateFor(result: string, evidenceType: string): LearningEpistemicState {
  switch (result) {
    case 'VALIDATED':
      // Only evidence-backed entries may display as VALIDATED.
      return evidenceType === 'AI_INFERENCE' ? 'HYPOTHESIS' : 'VALIDATED';
    case 'INVALIDATED':
      return 'INVALIDATED';
    case 'INCONCLUSIVE':
      return evidenceType === 'AI_INFERENCE' ? 'HYPOTHESIS' : 'UNVERIFIED';
    default:
      return 'UNVERIFIED';
  }
}

/**
 * Deterministic learning → experiment → product → revenue attribution.
 * Rule: LearningEntry.experimentId → ProductEvent(experimentId, PURCHASE).
 * Purchases without a matching experiment stay unattributed; there is no
 * partial credit and no estimation.
 */
export async function outcomeLinkFor(entry: {
  id: string;
  opportunityId: string | null;
  experimentId: string | null;
}): Promise<OutcomeLink | null> {
  if (!entry.experimentId) return null;

  const experiment = await db.growthExperiment.findUnique({
    where: { id: entry.experimentId },
    select: { id: true, opportunityId: true, experimentType: true, status: true, portfolioItemId: true },
  });
  if (!experiment) return null;

  const purchases = await db.productEvent.findMany({
    where: { experimentId: experiment.id, eventType: 'PURCHASE' },
    select: { productId: true, amountUsd: true },
    take: 500,
  });

  const conversions = purchases.length;
  const revenueUsd = purchases.reduce((sum, p) => sum + (p.amountUsd ?? 0), 0);
  const productId = experiment.portfolioItemId ?? purchases.find((p) => p.productId)?.productId ?? null;

  const chain: string[] = [`LearningEntry:${entry.id}`, `GrowthExperiment:${experiment.id}`];
  if (productId) chain.push(`Product:${productId}`);
  chain.push(conversions > 0 ? `${conversions} recorded purchase(s)` : 'no recorded purchases');

  return {
    chain,
    experimentId: experiment.id,
    productId,
    opportunityId: experiment.opportunityId ?? entry.opportunityId,
    conversions,
    revenueUsd:
      conversions > 0
        ? { value: Math.round(revenueUsd * 100) / 100, label: 'REAL', source: `Sum of ${conversions} ProductEvent.PURCHASE rows with experimentId ${experiment.id}` }
        : { value: null, label: 'UNKNOWN', source: 'No purchase events recorded for this experiment' },
    attribution: conversions > 0 ? 'ATTRIBUTED' : 'UNATTRIBUTED',
  };
}

export async function getLearningObservations(limit = 50): Promise<{
  entries: LearningObservation[];
  counts: Record<LearningEpistemicState, number>;
}> {
  const rows = await db.learningEntry.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(200, Math.max(1, limit)),
  });

  const entries: LearningObservation[] = [];
  for (const row of rows) {
    const outcomeLink = await outcomeLinkFor(row);
    entries.push({
      id: row.id,
      // The learning layer has no agent column; the agent provenance is
      // UNKNOWN rather than guessed.
      agent: null,
      hypothesis: row.hypothesis,
      result: row.result,
      epistemicState: epistemicStateFor(row.result, row.evidenceType),
      confidence: row.confidence,
      evidenceType: row.evidenceType,
      metric: row.metric,
      baselineValue: row.baselineValue,
      measuredValue: row.measuredValue,
      applicability: row.applicability,
      opportunityId: row.opportunityId,
      experimentId: row.experimentId,
      createdAt: row.createdAt.toISOString(),
      outcomeLink,
    });
  }

  const counts: Record<LearningEpistemicState, number> = {
    OBSERVED: 0,
    HYPOTHESIS: 0,
    VALIDATED: 0,
    INVALIDATED: 0,
    SUPERSEDED: 0,
    UNVERIFIED: 0,
  };
  for (const e of entries) counts[e.epistemicState] += 1;

  return { entries, counts };
}
