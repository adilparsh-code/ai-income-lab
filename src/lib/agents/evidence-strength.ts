// Phase 6 — Deterministic evidence-strength classification.
//
// Evidence strength answers: how strong is the recorded evidence for this
// opportunity? It is computed ONLY from provenance (stored evidence types),
// record availability, and outcome data — never from AI confidence numbers,
// which are explicitly NOT evidence strength.
//
//   VERIFIED    — externally verified sources AND real outcome data exist
//   SUPPORTED   — verified/user-entered records exist but outcomes are thin
//   PARTIAL     — only user-entered records; no verified external evidence
//   INFERRED    — only AI inference is on file (no verified/user data)
//   CONFLICTING — verified outcome data contradicts the positive AI/user
//                 outlook recorded for the opportunity
//   MISSING     — nothing on file

import type { EvidenceType } from './types';

export type EvidenceStrength =
  | 'VERIFIED'
  | 'SUPPORTED'
  | 'PARTIAL'
  | 'INFERRED'
  | 'CONFLICTING'
  | 'MISSING';

export interface EvidenceStrengthInput {
  /** Provenance types actually stored for this scope (AgentLog/EvidenceItem). */
  presentEvidenceTypes: EvidenceType[];
  /** Whether any real outcome data (experiments, revenue, traffic events) exists. */
  hasOutcomeData: boolean;
  /** Whether a positive outlook was recorded (research PROMISING / BM PROCEED...). */
  hasPositiveOutlook: boolean;
  /** True when recorded outcomes are flat/negative (no revenue, KILL...). */
  outcomesAreNonPositive: boolean;
}

export interface EvidenceStrengthResult {
  strength: EvidenceStrength;
  /** Deterministic human-readable basis; no AI is involved. */
  basis: string;
}

/**
 * Classify evidence strength. CONFLICTING wins over everything when verified
 * outcomes contradict a recorded positive outlook (real data beats optimism);
 * otherwise the classification descends by what provenance is actually present.
 */
export function classifyEvidenceStrength(input: EvidenceStrengthInput): EvidenceStrengthResult {
  const types = new Set(input.presentEvidenceTypes);
  const hasVerified = types.has('VERIFIED_DATA');
  const hasUser = types.has('USER_ENTERED');
  const hasAi = types.has('AI_INFERENCE');

  if (input.outcomesAreNonPositive && input.hasPositiveOutlook && input.hasOutcomeData) {
    return {
      strength: 'CONFLICTING',
      basis:
        'Recorded outcome data is flat/negative while a positive outlook is on file; real data outranks the outlook.',
    };
  }
  if (hasVerified && input.hasOutcomeData) {
    return {
      strength: 'VERIFIED',
      basis: 'Verified evidence and real outcome data both exist.',
    };
  }
  if (hasVerified || hasUser) {
    return {
      strength: input.hasOutcomeData ? 'VERIFIED' : 'SUPPORTED',
      basis: hasVerified
        ? 'Verified evidence exists; outcome data is limited.'
        : 'User-entered records exist but no verified external evidence yet.',
    };
  }
  if (hasUser && input.hasOutcomeData) {
    return { strength: 'SUPPORTED', basis: 'User-entered records with some outcome data.' };
  }
  if (hasAi && !hasVerified && !hasUser) {
    return {
      strength: 'INFERRED',
      basis: 'Only AI inference is on file; no verified or user-entered evidence.',
    };
  }
  if (types.size === 0) {
    return { strength: 'MISSING', basis: 'No evidence of any type is recorded for this scope.' };
  }
  return { strength: 'PARTIAL', basis: 'Mixed or partial evidence; key verification is absent.' };
}

/**
 * Map an evidence-strength classification onto the routing state's confidence
 * surface. Deterministic: identical inputs produce identical labels.
 */
export function strengthRoutingHint(strength: EvidenceStrength): string {
  switch (strength) {
    case 'VERIFIED':
      return 'Evidence is verified; proceed on recorded data.';
    case 'SUPPORTED':
      return 'Evidence is supported but incomplete; gather the missing outcome data.';
    case 'PARTIAL':
      return 'Evidence is partial; verification is required before scaling.';
    case 'INFERRED':
      return 'Evidence is AI inference only; verify with real-world data.';
    case 'CONFLICTING':
      return 'Evidence conflicts; a human must reconcile the disagreement.';
    case 'MISSING':
      return 'No evidence on file; start at research.';
  }
}
