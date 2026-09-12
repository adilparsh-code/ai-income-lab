import { SCORING_WEIGHTS, SCORING_LABELS, type HalalStatus } from './constants';

export interface ScoreInput {
  demandScore: number; // 0-100
  commercialIntentScore: number; // 0-100
  competitionScore: number; // 0-100 (higher = less competition = better)
  startupCostScore: number; // 0-100 (higher = lower cost = better)
  automationScore: number; // 0-100
  differentiationScore: number; // 0-100
  monetizationScore: number; // 0-100
  halalConfidenceScore: number; // 0-100
  halalStatus: HalalStatus;
}

export interface ScoreBreakdown {
  factor: string;
  label: string;
  rawScore: number;
  weight: number;
  weightedScore: number;
}

export interface ScoringResult {
  overallScore: number;
  breakdown: ScoreBreakdown[];
  isInvestable: boolean;
  warnings: string[];
  explanation: string;
}

export function calculateOpportunityScore(input: ScoreInput): ScoringResult {
  const warnings: string[] = [];
  
  // If halal status is NOT_ALLOWED, score is 0 and not investable
  if (input.halalStatus === 'NOT_ALLOWED') {
    const breakdown = buildBreakdown(input);
    return {
      overallScore: 0,
      breakdown,
      isInvestable: false,
      warnings: ['This opportunity has been flagged as NOT_ALLOWED under halal compliance screening. Investment is blocked.'],
      explanation: 'Score set to 0: This opportunity does not pass halal compliance screening and cannot receive an investment recommendation.',
    };
  }

  if (input.halalStatus === 'REVIEW_REQUIRED') {
    warnings.push('This opportunity requires human review for halal compliance before proceeding.');
  }

  const breakdown = buildBreakdown(input);
  const overallScore = Math.round(
    breakdown.reduce((sum, item) => sum + item.weightedScore, 0)
  );

  const explanation = generateExplanation(overallScore, breakdown, input.halalStatus);

  return {
    overallScore,
    breakdown,
    isInvestable: overallScore > 0 && input.halalStatus !== 'NOT_ALLOWED',
    warnings,
    explanation,
  };
}

function buildBreakdown(input: ScoreInput): ScoreBreakdown[] {
  const mapping: { factor: keyof typeof SCORING_WEIGHTS; rawScore: number }[] = [
    { factor: 'demand', rawScore: input.demandScore },
    { factor: 'commercialIntent', rawScore: input.commercialIntentScore },
    { factor: 'competition', rawScore: input.competitionScore },
    { factor: 'startupCost', rawScore: input.startupCostScore },
    { factor: 'automation', rawScore: input.automationScore },
    { factor: 'differentiation', rawScore: input.differentiationScore },
    { factor: 'monetization', rawScore: input.monetizationScore },
    { factor: 'halalCompliance', rawScore: input.halalConfidenceScore },
  ];

  return mapping.map(({ factor, rawScore }) => ({
    factor,
    label: SCORING_LABELS[factor],
    rawScore: Math.max(0, Math.min(100, rawScore)),
    weight: SCORING_WEIGHTS[factor],
    weightedScore: Math.round(Math.max(0, Math.min(100, rawScore)) * SCORING_WEIGHTS[factor] * 100) / 100,
  }));
}

function generateExplanation(
  overallScore: number,
  breakdown: ScoreBreakdown[],
  halalStatus: HalalStatus
): string {
  const sorted = [...breakdown].sort((a, b) => b.rawScore - a.rawScore);
  const topStrengths = sorted.slice(0, 3);
  const weaknesses = sorted.filter(s => s.rawScore < 50);

  let explanation = `Overall score: ${overallScore}/100. `;

  if (overallScore >= 80) {
    explanation += 'This is a strong opportunity. ';
  } else if (overallScore >= 60) {
    explanation += 'This is a moderate opportunity with potential. ';
  } else if (overallScore >= 40) {
    explanation += 'This opportunity has some merit but significant challenges. ';
  } else {
    explanation += 'This opportunity has substantial risks. ';
  }

  explanation += `Key strengths: ${topStrengths.map(s => \`\${s.label} (\${s.rawScore})\`).join(', ')}. `;

  if (weaknesses.length > 0) {
    explanation += `Areas of concern: ${weaknesses.map(s => \`\${s.label} (\${s.rawScore})\`).join(', ')}. `;
  }

  if (halalStatus === 'REVIEW_REQUIRED') {
    explanation += 'Note: Halal compliance requires human review before proceeding.';
  }

  return explanation;
}
