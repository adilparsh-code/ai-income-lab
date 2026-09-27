// Phase 8C — Transparent deterministic opportunity scoring.
//
// Extends the existing weighted score (src/lib/scoring.ts) with provenance
// weighting. VERIFIED_DATA outranks HUMAN_DECISION outranks SEARCH_DISCOVERY
// outranks AI_INFERENCE. Every score is explainable. Pure: no DB, no AI.

import { calculateOpportunityScore, type ScoreInput } from '@/lib/scoring';
import { evidenceRank, type EvidenceClass } from './types';

export interface ScoringFactor {
  name: string;
  raw: number;
  weight: number;
  evidence: EvidenceClass;
  note: string;
}

export interface ProvenanceAwareInput {
  demand: { value: number; evidence: EvidenceClass; note?: string };
  competition: { value: number; evidence: EvidenceClass; note?: string };
  effort: { value: number; evidence: EvidenceClass; note?: string };
  cost: { value: number; evidence: EvidenceClass; note?: string };
  monetization: { value: number; evidence: EvidenceClass; note?: string };
  evidenceStrength: { value: number; evidence: EvidenceClass; note?: string };
  risk: { value: number; evidence: EvidenceClass; note?: string };
  halalCompatibility: { value: number; evidence: EvidenceClass; note?: string };
  executionComplexity: { value: number; evidence: EvidenceClass; note?: string };
  commercialIntent?: { value: number; evidence: EvidenceClass; note?: string };
  automation?: { value: number; evidence: EvidenceClass; note?: string };
  differentiation?: { value: number; evidence: EvidenceClass; note?: string };
  halalStatus: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
}

export interface ExplainableScore {
  overall: number;
  investable: boolean;
  factors: ScoringFactor[];
  provenanceMix: Record<EvidenceClass, number>;
  dominantEvidence: EvidenceClass;
  verifiedOutranksInference: boolean;
  warnings: string[];
  explanation: string;
}

const FACTOR_WEIGHTS: Record<string, number> = {
  demand: 0.18,
  competition: 0.12,
  effort: 0.08,
  cost: 0.08,
  monetization: 0.14,
  evidenceStrength: 0.12,
  risk: 0.10,
  halalCompatibility: 0.10,
  executionComplexity: 0.08,
};

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function provenanceMultiplier(evidence: EvidenceClass): number {
  switch (evidence) {
    case 'VERIFIED_DATA': return 1.0;
    case 'HUMAN_DECISION': return 0.9;
    case 'SEARCH_DISCOVERY': return 0.7;
    case 'AI_INFERENCE': return 0.4;
  }
}

export function scoreOpportunity(input: ProvenanceAwareInput): ExplainableScore {
  if (input.halalStatus === 'NOT_ALLOWED') {
    return {
      overall: 0,
      investable: false,
      factors: [],
      provenanceMix: { VERIFIED_DATA: 0, HUMAN_DECISION: 0, SEARCH_DISCOVERY: 0, AI_INFERENCE: 0 },
      dominantEvidence: 'VERIFIED_DATA',
      verifiedOutranksInference: true,
      warnings: ['Halal screening is NOT_ALLOWED. Score is 0 and investment is blocked.'],
      explanation: 'Score set to 0: this opportunity does not pass halal compliance and cannot receive an investment recommendation.',
    };
  }

  const rawFactors: { name: string; item: { value: number; evidence: EvidenceClass; note?: string }; invert?: boolean }[] = [
    { name: 'demand', item: input.demand },
    { name: 'competition', item: input.competition },
    { name: 'effort', item: input.effort, invert: true },
    { name: 'cost', item: input.cost, invert: true },
    { name: 'monetization', item: input.monetization },
    { name: 'evidenceStrength', item: input.evidenceStrength },
    { name: 'risk', item: input.risk, invert: true },
    { name: 'halalCompatibility', item: input.halalCompatibility },
    { name: 'executionComplexity', item: input.executionComplexity, invert: true },
  ];

  const provenanceMix: Record<EvidenceClass, number> = {
    VERIFIED_DATA: 0, HUMAN_DECISION: 0, SEARCH_DISCOVERY: 0, AI_INFERENCE: 0,
  };

  const factors: ScoringFactor[] = rawFactors.map(({ name, item, invert }) => {
    const raw = invert ? 100 - clamp(item.value) : clamp(item.value);
    const adjusted = raw * provenanceMultiplier(item.evidence);
    provenanceMix[item.evidence] += 1;
    return {
      name,
      raw: Math.round(adjusted * 100) / 100,
      weight: FACTOR_WEIGHTS[name],
      evidence: item.evidence,
      note: item.note ?? `${name} sourced from ${item.evidence}`,
    };
  });

  let weighted = factors.reduce((sum, f) => sum + f.raw * f.weight, 0);
  const verifiedCount = provenanceMix.VERIFIED_DATA;
  const inferenceCount = provenanceMix.AI_INFERENCE;
  if (verifiedCount > 0 && inferenceCount > 0) {
    weighted = weighted * (1 + 0.05 * verifiedCount);
  }

  const overall = Math.round(Math.max(0, Math.min(100, weighted)));
  const dominant = (Object.entries(provenanceMix) as [EvidenceClass, number][])
    .sort((a, b) => evidenceRank(b[0]) - evidenceRank(a[0]) || b[1] - a[1])[0][0];

  const warnings: string[] = [];
  if (input.halalStatus === 'REVIEW_REQUIRED') {
    warnings.push('Halal status is REVIEW_REQUIRED. Human review is required before proceeding.');
  }
  if (verifiedCount === 0 && inferenceCount > 0) {
    warnings.push('Score is dominated by AI_INFERENCE. Verified evidence would outrank this result.');
  }
  if (input.risk.value >= 70 && input.risk.evidence === 'VERIFIED_DATA') {
    warnings.push('Verified high risk is present; verified risk outranks optimistic AI inference.');
  }

  const top = [...factors].sort((a, b) => b.raw - a.raw).slice(0, 3);
  const weak = factors.filter((f) => f.raw < 40);
  let explanation = `Overall score ${overall}/100. Dominant evidence: ${dominant}. `;
  explanation += `Top factors: ${top.map((f) => `${f.name}=${f.raw} (${f.evidence})`).join(', ')}. `;
  if (weak.length > 0) {
    explanation += `Weak factors: ${weak.map((f) => `${f.name}=${f.raw}`).join(', ')}. `;
  }
  explanation += 'Verified evidence outranks AI inference by construction (provenance multiplier).';

  return {
    overall,
    investable: overall > 0,
    factors,
    provenanceMix,
    dominantEvidence: dominant,
    verifiedOutranksInference: evidenceRank('VERIFIED_DATA') > evidenceRank('AI_INFERENCE'),
    warnings,
    explanation,
  };
}

/** Bridge existing opportunity numeric scores into the provenance-aware scorer. */
export function scoreFromLegacy(input: ScoreInput, evidence: EvidenceClass = 'USER_ENTERED' as never): ExplainableScore {
  const base = calculateOpportunityScore(input);
  const mappedEvidence: EvidenceClass = evidence === ('USER_ENTERED' as never) ? 'HUMAN_DECISION' : evidence;
  return scoreOpportunity({
    demand: { value: input.demandScore, evidence: mappedEvidence },
    competition: { value: input.competitionScore, evidence: mappedEvidence },
    effort: { value: 100 - input.automationScore, evidence: mappedEvidence },
    cost: { value: 100 - input.startupCostScore, evidence: mappedEvidence },
    monetization: { value: input.monetizationScore, evidence: mappedEvidence },
    evidenceStrength: { value: base.overallScore, evidence: mappedEvidence },
    risk: { value: 100 - input.differentiationScore, evidence: mappedEvidence },
    halalCompatibility: { value: input.halalConfidenceScore, evidence: 'VERIFIED_DATA' },
    executionComplexity: { value: 100 - input.automationScore, evidence: mappedEvidence },
    commercialIntent: { value: input.commercialIntentScore, evidence: mappedEvidence },
    automation: { value: input.automationScore, evidence: mappedEvidence },
    differentiation: { value: input.differentiationScore, evidence: mappedEvidence },
    halalStatus: input.halalStatus,
  });
}
