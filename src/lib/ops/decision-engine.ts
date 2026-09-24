// Phase 8E — Lifecycle Decision Engine.
//
// CONTINUE | ITERATE | PAUSE | KILL | SCALE | HUMAN_REVIEW
// Deterministic, evidence-based. AI cannot bypass these rules.
// Human decisions remain authoritative when present.

import type { EvidenceClass, LifecycleDecision } from './types';
import { evidenceRank } from './types';

export interface DecisionEvidence {
  failedValidationCount: number;
  positiveValidationCount: number;
  completedDecisionCount: number;
  netRevenue: number;
  trafficEvents: number;
  conversionEvents: number;
  costsUsd: number;
  halalStatus: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED' | string;
  hasAmbiguousSignal: boolean;
  highRisk: boolean;
  humanDecision?: LifecycleDecision | null;
  humanDecisionEvidence?: EvidenceClass;
  simulated?: boolean;
}

export interface DecisionResult {
  decision: LifecycleDecision;
  reason: string;
  evidenceType: EvidenceClass;
  overridableByHuman: boolean;
  simulated: boolean;
}

const KILL_FAILURE_THRESHOLD = 3;

export function decideLifecycle(input: DecisionEvidence): DecisionResult {
  const simulated = input.simulated === true;
  if (input.humanDecision) {
    return {
      decision: input.humanDecision,
      reason: `Human decision (${input.humanDecision}) is authoritative and cannot be overridden by AI.`,
      evidenceType: input.humanDecisionEvidence ?? 'HUMAN_DECISION',
      overridableByHuman: false,
      simulated,
    };
  }

  if (input.halalStatus === 'NOT_ALLOWED') {
    return {
      decision: 'KILL',
      reason: 'Halal screening is NOT_ALLOWED. The candidate is killed; no further execution.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }
  if (input.halalStatus === 'REVIEW_REQUIRED') {
    return {
      decision: 'HUMAN_REVIEW',
      reason: 'Halal status is REVIEW_REQUIRED. AI cannot approve.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }
  if (input.highRisk || input.hasAmbiguousSignal) {
    return {
      decision: 'HUMAN_REVIEW',
      reason: input.highRisk
        ? 'High-risk evidence is present; a qualified human must review.'
        : 'Evidence is ambiguous; a qualified human must review.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.failedValidationCount >= KILL_FAILURE_THRESHOLD && input.positiveValidationCount === 0) {
    return {
      decision: 'KILL',
      reason: `Repeated failed validation (${input.failedValidationCount} without SCALE). Candidate is killed.`,
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  const profit = input.netRevenue - input.costsUsd;
  if (input.netRevenue > 0 && profit > 0 && input.trafficEvents > 0 && input.conversionEvents > 0) {
    return {
      decision: 'SCALE',
      reason: `Verified positive economics (net $${input.netRevenue.toFixed(2)}, profit $${profit.toFixed(2)}). Scale candidate.`,
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.positiveValidationCount > 0 && input.netRevenue === 0 && input.trafficEvents === 0) {
    return {
      decision: 'CONTINUE',
      reason: 'Promising validation signal without recorded economics yet. Continue the loop.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.failedValidationCount > 0 && input.failedValidationCount < KILL_FAILURE_THRESHOLD) {
    return {
      decision: 'ITERATE',
      reason: `Weak but recoverable signal (${input.failedValidationCount} failed validation(s)). Iterate the hypothesis.`,
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.trafficEvents > 0 && input.conversionEvents === 0 && input.netRevenue === 0) {
    return {
      decision: 'ITERATE',
      reason: 'Traffic arrived without conversions. Iterate offer, pricing, or checkout.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.netRevenue < 0 || (input.costsUsd > 0 && profit < 0 && input.netRevenue > 0)) {
    return {
      decision: 'PAUSE',
      reason: 'Unit economics are not contribution-positive. Pause before further spend.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  if (input.completedDecisionCount === 0 && input.failedValidationCount === 0 && input.positiveValidationCount === 0) {
    return {
      decision: 'CONTINUE',
      reason: 'Insufficient outcome data. Continue collecting evidence; nothing is fabricated.',
      evidenceType: 'VERIFIED_DATA',
      overridableByHuman: true,
      simulated,
    };
  }

  return {
    decision: 'CONTINUE',
    reason: 'No decisive kill/scale signal. Continue with existing gates intact.',
    evidenceType: 'VERIFIED_DATA',
    overridableByHuman: true,
    simulated,
  };
}

export function humanOverridesAi(human: LifecycleDecision, ai: LifecycleDecision): LifecycleDecision {
  void ai;
  return human;
}

export function cannotBypass(decision: DecisionResult, attempted: LifecycleDecision): boolean {
  if (decision.evidenceType === 'HUMAN_DECISION') return attempted !== decision.decision;
  if (evidenceRank(decision.evidenceType) >= evidenceRank('VERIFIED_DATA') && decision.decision === 'KILL') {
    return attempted === 'SCALE' || attempted === 'CONTINUE';
  }
  return false;
}
