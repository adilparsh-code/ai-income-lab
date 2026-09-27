// Phase 9 — Growth Decision Engine (deterministic, bounded).
//
// Maps recorded portfolio evidence onto the Phase 9 decision vocabulary:
// CONTINUE | ITERATE | PAUSE | STOP | SCALE_WITHIN_BUDGET | NEEDS_HUMAN_REVIEW.
// AI has no vote here. Human decisions, when present, are authoritative.
// SCALE_WITHIN_BUDGET is the ONLY spend-increasing outcome and it is bounded
// by the ResourceAllocation caps enforced in budget.ts — never by this engine.

import type { GrowthDecisionType, GrowthEvidenceType, GrowthHealthState } from './types';

export interface DecisionInput {
  health: GrowthHealthState;
  visitors: number;
  conversions: number;
  netRevenueUsd: number;
  costsUsd: number;
  activeExperiments: number;
  completedExperiments: number;
  validatedLearnings: number;
  invalidatedLearnings: number;
  remainingMonthlyBudgetUsd: number;
  halalStatus: string;
  /** A recorded human decision overrides everything (evidence HUMAN_DECISION). */
  humanDecision?: GrowthDecisionType | null;
}

export interface DecisionOutput {
  decision: GrowthDecisionType;
  reason: string;
  evidenceType: GrowthEvidenceType;
  /** true when the decision increases spend (bounded by allocation caps). */
  spendIncreasing: boolean;
  rules: string[];
}

/**
 * Documented rules (first match wins):
 *  1. recorded human decision            → that decision (authoritative)
 *  2. halal NOT_ALLOWED                  → STOP
 *  3. halal REVIEW_REQUIRED              → NEEDS_HUMAN_REVIEW
 *  4. health BLOCKED/STOPPED             → STOP
 *  5. health NEEDS_DATA                  → CONTINUE (collect evidence only; $0)
 *  6. net loss (profit < 0)              → PAUSE (stop spend before more damage)
 *  7. health UNDERPERFORMING             → ITERATE (traffic without conversions → iterate offer)
 *  8. healthy + validated learnings + remaining budget → SCALE_WITHIN_BUDGET
 *     (bounded: only within remainingMonthlyBudgetUsd and existing caps)
 *  9. completed experiments exist        → ITERATE (act on the learning)
 * 10. otherwise                          → CONTINUE
 */
export function decideGrowth(input: DecisionInput): DecisionOutput {
  const rules: string[] = [];

  if (input.humanDecision) {
    rules.push(`R0: recorded human decision (${input.humanDecision}) is authoritative.`);
    return {
      decision: input.humanDecision,
      reason: `Human decision ${input.humanDecision} is authoritative and cannot be overridden by the engine.`,
      evidenceType: 'HUMAN_DECISION',
      spendIncreasing: input.humanDecision === 'SCALE_WITHIN_BUDGET',
      rules,
    };
  }

  if (input.halalStatus === 'NOT_ALLOWED') {
    rules.push('R2: halalStatus=NOT_ALLOWED → STOP. No further spend or execution.');
    return { decision: 'STOP', reason: 'Halal screening is NOT_ALLOWED; growth stopped.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }
  if (input.halalStatus === 'REVIEW_REQUIRED') {
    rules.push('R3: halalStatus=REVIEW_REQUIRED → NEEDS_HUMAN_REVIEW. AI cannot approve.');
    return { decision: 'NEEDS_HUMAN_REVIEW', reason: 'Halal status REVIEW_REQUIRED requires a qualified human decision.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }
  if (input.health === 'BLOCKED' || input.health === 'STOPPED') {
    rules.push(`R4: health=${input.health} → STOP.`);
    return { decision: 'STOP', reason: `Opportunity health is ${input.health}.`, evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }
  if (input.health === 'NEEDS_DATA') {
    rules.push(`R5: health=NEEDS_DATA with ${input.visitors} visitors → CONTINUE (evidence collection only, $0 spend).`);
    return { decision: 'CONTINUE', reason: 'Insufficient recorded data; continue collecting evidence. No spend is authorized.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }

  const profit = input.netRevenueUsd - input.costsUsd;
  if (input.netRevenueUsd > 0 && profit < 0) {
    rules.push(`R6: net $${input.netRevenueUsd.toFixed(2)} − costs $${input.costsUsd.toFixed(2)} = profit $${profit.toFixed(2)} < 0 → PAUSE.`);
    return { decision: 'PAUSE', reason: 'Unit economics are contribution-negative; spending paused before further loss.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }
  if (input.health === 'UNDERPERFORMING') {
    rules.push(`R7: health=UNDERPERFORMING (${input.visitors} visitors, ${input.conversions} conversions) → ITERATE.`);
    return { decision: 'ITERATE', reason: 'Traffic is arriving without conversions; iterate offer, pricing, or CTA.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }
  if (input.health === 'HEALTHY' && input.validatedLearnings > 0 && input.remainingMonthlyBudgetUsd > 0) {
    rules.push(
      `R8: health=HEALTHY with ${input.validatedLearnings} validated learning(s) and $${input.remainingMonthlyBudgetUsd.toFixed(2)} remaining budget → SCALE_WITHIN_BUDGET (bounded by allocation caps).`,
    );
    return {
      decision: 'SCALE_WITHIN_BUDGET',
      reason: `Positive economics plus validated learning; scale ONLY within the remaining allocation budget ($${input.remainingMonthlyBudgetUsd.toFixed(2)}).`,
      evidenceType: 'VERIFIED_DATA',
      spendIncreasing: true,
      rules,
    };
  }
  if (input.completedExperiments > 0 || input.invalidatedLearnings > 0) {
    rules.push(`R9: ${input.completedExperiments} completed experiment(s), ${input.invalidatedLearnings} invalidated learning(s) → ITERATE.`);
    return { decision: 'ITERATE', reason: 'Completed experiments produced learning; iterate on the next bounded hypothesis.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
  }

  rules.push('R10: no decisive signal → CONTINUE.');
  return { decision: 'CONTINUE', reason: 'No decisive scale/stop signal; continue with existing gates intact.', evidenceType: 'VERIFIED_DATA', spendIncreasing: false, rules };
}
