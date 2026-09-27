// Phase 9 — Opportunity Health (deterministic, explainable).
//
// Health is a pure function of RECORDED metrics + halal status + lifecycle
// flags. There is no AI judgment and no hidden weighting: every state change
// is traceable to a documented rule below. Zero-data situations are explicit
// (NEEDS_DATA), never resolved by invention.

import {
  MIN_VISITORS_FOR_HEALTH,
  STALE_DAYS,
  UNDERPERFORMANCE_NET_LOSS_USD,
  type GrowthConfidence,
  type GrowthHealthState,
  type GrowthTrend,
} from './types';

export interface HealthInput {
  halalStatus: string; // HALAL | REVIEW_REQUIRED | NOT_ALLOWED | ...
  opportunityStatus: string; // Opportunity.status (PAUSED, REJECTED, ...)
  stopped: boolean; // explicit human/operator stop flag
  visitors: number;
  conversions: number;
  grossRevenueUsd: number;
  netRevenueUsd: number; // verified Revenue rows only
  costsUsd: number;
  activeExperiments: number;
  lastActivityAt: string | null; // ISO timestamp of last recorded event/revenue/decision
  now: Date;
}

export interface HealthResult {
  state: GrowthHealthState;
  trend: GrowthTrend;
  confidence: GrowthConfidence;
  score: number; // 0..100, deterministic
  rules: string[]; // ordered rule trace — every state is explainable
}

/**
 * Documented rules (evaluated top-down; first match wins):
 *  1. halal NOT_ALLOWED  → BLOCKED          (score 0; nothing may run)
 *  2. explicit stop      → STOPPED          (score 0)
 *  3. halal REVIEW_REQUIRED → NEEDS_HUMAN_REVIEW surfaced as NEEDS_DATA + warning
 *     (AI cannot approve; a human must decide before growth continues)
 *  4. visitors < MIN_VISITORS_FOR_HEALTH → NEEDS_DATA (no invented traffic)
 *  5. net loss or zero conversions with traffic → UNDERPERFORMING
 *  6. stale (> STALE_DAYS no activity) → WATCH
 *  7. profitable with conversions → HEALTHY
 *  8. everything else → WATCH
 */
export function computeHealth(input: HealthInput): HealthResult {
  const rules: string[] = [];

  if (input.halalStatus === 'NOT_ALLOWED') {
    rules.push('R1: halalStatus=NOT_ALLOWED → BLOCKED (no execution permitted).');
    return { state: 'BLOCKED', trend: 'UNKNOWN', confidence: 'HIGH', score: 0, rules };
  }
  if (input.stopped) {
    rules.push('R2: explicit stop flag → STOPPED.');
    return { state: 'STOPPED', trend: 'UNKNOWN', confidence: 'HIGH', score: 0, rules };
  }

  // Deterministic trend from recorded conversions vs traffic balance.
  const trend: GrowthTrend =
    input.visitors === 0
      ? 'UNKNOWN'
      : input.conversions > 0 && input.netRevenueUsd >= 0
        ? 'UP'
        : input.conversions === 0 && input.visitors > 0
          ? 'DOWN'
          : 'FLAT';

  if (input.halalStatus === 'REVIEW_REQUIRED') {
    rules.push('R3: halalStatus=REVIEW_REQUIRED → growth is gated behind human review.');
    return { state: 'NEEDS_DATA', trend, confidence: 'LOW', score: 0, rules };
  }

  if (input.visitors < MIN_VISITORS_FOR_HEALTH) {
    rules.push(`R4: only ${input.visitors} recorded visitors (< ${MIN_VISITORS_FOR_HEALTH}) → NEEDS_DATA. Nothing is fabricated.`);
    return { state: 'NEEDS_DATA', trend, confidence: 'LOW', score: 0, rules };
  }

  const profit = input.netRevenueUsd - input.costsUsd;
  if (profit < UNDERPERFORMANCE_NET_LOSS_USD || (input.conversions === 0 && input.visitors >= MIN_VISITORS_FOR_HEALTH)) {
    rules.push(`R5: profit $${profit.toFixed(2)} with ${input.conversions} conversions → UNDERPERFORMING.`);
    return { state: 'UNDERPERFORMING', trend, confidence: 'MEDIUM', score: 10, rules };
  }

  if (input.lastActivityAt) {
    const staleDays = (input.now.getTime() - new Date(input.lastActivityAt).getTime()) / 86_400_000;
    if (staleDays > STALE_DAYS) {
      rules.push(`R6: no recorded activity for ${staleDays.toFixed(1)} days (> ${STALE_DAYS}) → WATCH.`);
      return { state: 'WATCH', trend, confidence: 'MEDIUM', score: 35, rules };
    }
  } else {
    rules.push(`R6b: no recorded activity timestamp → WATCH (conservative default).`);
    return { state: 'WATCH', trend, confidence: 'MEDIUM', score: 35, rules };
  }

  if (input.conversions > 0 && profit >= 0) {
    rules.push(`R7: ${input.conversions} conversions with non-negative profit ($${profit.toFixed(2)}) → HEALTHY.`);
    return { state: 'HEALTHY', trend: 'UP', confidence: 'HIGH', score: 80, rules };
  }

  rules.push('R8: no decisive signal → WATCH (conservative default).');
  return { state: 'WATCH', trend, confidence: 'MEDIUM', score: 35, rules };
}

/**
 * Deterministic portfolio score: health base + verified evidence bonuses.
 * Pure arithmetic; the breakdown is returned for the audit trail.
 */
export function computePortfolioScore(parts: {
  health: HealthResult;
  experimentCount: number;
  completedExperimentCount: number;
  validatedLearningCount: number;
  netRevenueUsd: number;
}): { score: number; breakdown: string[] } {
  const breakdown: string[] = [];
  let score = parts.health.score;
  breakdown.push(`health(${parts.health.state})=${parts.health.score}`);

  const expBonus = Math.min(10, parts.experimentCount * 3);
  const completedBonus = Math.min(6, parts.completedExperimentCount * 2);
  const learningBonus = Math.min(6, parts.validatedLearningCount * 3);
  const revenueBonus = parts.netRevenueUsd > 0 ? 4 : 0;

  score += expBonus + completedBonus + learningBonus + revenueBonus;
  if (expBonus > 0) breakdown.push(`experiments=${parts.experimentCount} (+${expBonus})`);
  if (completedBonus > 0) breakdown.push(`completedExperiments=${parts.completedExperimentCount} (+${completedBonus})`);
  if (learningBonus > 0) breakdown.push(`validatedLearning=${parts.validatedLearningCount} (+${learningBonus})`);
  if (revenueBonus > 0) breakdown.push('verifiedRevenue>0 (+4)');

  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown };
}
