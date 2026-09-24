import type { EvidenceType } from '@/lib/agents/types';
import type { HalalStatus } from '@/lib/constants';

export const SCORE_EVIDENCE_RANK: Record<EvidenceType, number> = {
  VERIFIED_DATA: 4,
  USER_ENTERED: 3,
  SEARCH_DISCOVERY: 2,
  AI_INFERENCE: 1,
};

export type ScoreDimension = 'demand' | 'competition' | 'productionEffort' | 'estimatedCost' | 'monetization' | 'evidenceStrength' | 'risk' | 'halalCompatibility' | 'executionComplexity';

export interface DimensionInput {
  value: number;
  evidenceType: EvidenceType;
  source: string;
}

export interface OpportunityScoreInput {
  dimensions: Record<ScoreDimension, DimensionInput>;
  halalStatus: HalalStatus;
}

export interface ScoreExplanation {
  dimension: ScoreDimension;
  label: string;
  value: number;
  evidenceType: EvidenceType;
  source: string;
  evidenceRank: number;
  contribution: number;
  explanation: string;
}

export interface OpportunityScoreResult {
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW';
  explanations: ScoreExplanation[];
  warnings: string[];
  decision: 'INVESTABLE' | 'HUMAN_REVIEW' | 'BLOCKED';
  explanation: string;
}

const WEIGHTS: Record<ScoreDimension, number> = {
  demand: 0.18, competition: 0.10, productionEffort: 0.10, estimatedCost: 0.10, monetization: 0.15,
  evidenceStrength: 0.15, risk: 0.08, halalCompatibility: 0.09, executionComplexity: 0.05,
};
const LABELS: Record<ScoreDimension, string> = {
  demand: 'Demand evidence', competition: 'Competition', productionEffort: 'Production effort', estimatedCost: 'Estimated cost',
  monetization: 'Monetization potential', evidenceStrength: 'Evidence strength', risk: 'Risk', halalCompatibility: 'Halal compatibility', executionComplexity: 'Execution complexity',
};

function bounded(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; }

/** Deterministic, provenance-weighted score. AI inference can never outrank recorded evidence. */
export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScoreResult {
  const warnings: string[] = [];
  const explanations: ScoreExplanation[] = [];
  let weighted = 0;
  let evidenceTotal = 0;
  for (const dimension of Object.keys(WEIGHTS) as ScoreDimension[]) {
    const item = input.dimensions[dimension] ?? { value: 0, evidenceType: 'AI_INFERENCE' as EvidenceType, source: 'NOT_AVAILABLE' };
    const value = bounded(item.value);
    const rank = SCORE_EVIDENCE_RANK[item.evidenceType];
    // AI/search evidence is discounted, not treated as verified fact.
    const evidenceMultiplier = item.evidenceType === 'VERIFIED_DATA' ? 1 : item.evidenceType === 'USER_ENTERED' ? 0.95 : item.evidenceType === 'SEARCH_DISCOVERY' ? 0.75 : 0.5;
    const contribution = value * WEIGHTS[dimension] * evidenceMultiplier;
    weighted += contribution;
    evidenceTotal += rank;
    if (item.evidenceType === 'AI_INFERENCE') warnings.push(`${LABELS[dimension]} is AI_INFERENCE and is discounted; it is not verified evidence.`);
    if (item.evidenceType === 'SEARCH_DISCOVERY') warnings.push(`${LABELS[dimension]} is SEARCH_DISCOVERY and is discounted until fetched and verified.`);
    explanations.push({ dimension, label: LABELS[dimension], value, evidenceType: item.evidenceType, source: item.source.slice(0, 200), evidenceRank: rank, contribution: Number(contribution.toFixed(2)), explanation: `${value}/100 × ${Math.round(WEIGHTS[dimension] * 100)}% × ${Math.round(evidenceMultiplier * 100)}% ${item.evidenceType} evidence` });
  }
  const averageRank = evidenceTotal / explanations.length;
  const confidence = averageRank >= 3.5 ? 'HIGH' : averageRank >= 2.5 ? 'MEDIUM' : averageRank >= 1.5 ? 'LOW' : 'VERY_LOW';
  const blocked = input.halalStatus === 'NOT_ALLOWED';
  const review = input.halalStatus === 'REVIEW_REQUIRED' || confidence === 'VERY_LOW';
  const score = blocked ? 0 : Math.round(weighted);
  if (blocked) warnings.unshift('Halal screening returned NOT_ALLOWED; score is forced to zero.');
  if (review && !blocked) warnings.push('Human review is required before autonomous progression.');
  const strongest = [...explanations].sort((a, b) => b.contribution - a.contribution)[0];
  const weakest = [...explanations].sort((a, b) => a.contribution - b.contribution)[0];
  const explanation = `${blocked ? 'Blocked by halal screening.' : review ? 'Human review required.' : `Score ${score}/100 with ${confidence.toLowerCase()} evidence confidence.`} Strongest: ${strongest.label} (${strongest.contribution.toFixed(2)} contribution). Weakest: ${weakest.label} (${weakest.contribution.toFixed(2)}).`;
  return { score, confidence, explanations, warnings, decision: blocked ? 'BLOCKED' : review ? 'HUMAN_REVIEW' : 'INVESTABLE', explanation };
}
