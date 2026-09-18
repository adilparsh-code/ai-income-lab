// Phase 4.5.3 — ROI-aware AI model selection (pure layer).
//
// Optimizes COST × QUALITY × BUSINESS VALUE, not just cheap tokens: for a
// given task the router estimates task complexity from the request itself,
// determines the MINIMUM required capability tier, and selects the
// lowest-cost model in the existing price table that satisfies it.
//
// Honesty rules:
// - When no internal quality evidence exists for a model, the router says so
//   (evidence: 'NO_EVIDENCE') and falls back to the conservative default
//   policy model — it never pretends to know quality without data.
// - Complexity estimation is heuristic (deterministic, inspectable) and the
//   result is labelled as such. It never promotes output provenance.

import type { AiProviderId } from './provider';

// ---------------------------------------------------------------------------
// Capability tiers + complexity
// ---------------------------------------------------------------------------

/**
 * Ordered capability tiers (ascending). Models map onto a tier; a task's
 * required tier is the minimum that satisfies it. Tier 2 is the conservative
 * default for complex work in the current model table.
 */
export type ModelTier = 1 | 2;

export type TaskComplexity = 'SIMPLE' | 'MODERATE' | 'COMPLEX';

/** Signals used by the deterministic complexity estimator. */
export interface ComplexitySignals {
  purpose: string;
  /** Estimated prompt size in tokens (input context). */
  estimatedInputTokens: number;
  /** Number of distinct structured output fields requested. */
  outputFieldCount: number;
  /** Free-text goal supplied by the user/agent (opinion-free, size signal). */
  objective: string;
}

export interface ComplexityAssessment {
  complexity: TaskComplexity;
  requiredTier: ModelTier;
  /** Human-inspectable reasons; deterministic, never fabricated metrics. */
  reasons: string[];
}

const STRATEGIC_PURPOSE_PARTS = ['product', 'business-manager', 'strategy'];

/**
 * Deterministic complexity estimator. Rules (first match wins):
 * - COMPLEX  : strategic purposes (product concept / business rationale /
 *              strategy) OR very large output schemas — need reasoning depth.
 * - SIMPLE   : tiny prompts with small structured outputs (classification /
 *              short extraction shaped tasks).
 * - MODERATE : everything else.
 */
export function assessComplexity(signals: ComplexitySignals): ComplexityAssessment {
  const reasons: string[] = [];
  const purposeLower = signals.purpose.toLowerCase();
  const isStrategic = STRATEGIC_PURPOSE_PARTS.some((p) => purposeLower.includes(p));

  if (isStrategic || signals.outputFieldCount >= 10) {
    if (isStrategic) reasons.push(`Purpose "${signals.purpose}" is strategic/reasoning-heavy.`);
    if (signals.outputFieldCount >= 10) {
      reasons.push(`Large structured output (${signals.outputFieldCount} fields) requires reasoning depth.`);
    }
    return { complexity: 'COMPLEX', requiredTier: 2, reasons };
  }

  if (signals.estimatedInputTokens <= 400 && signals.outputFieldCount <= 3) {
    reasons.push('Small context and a small structured output suit a cheap fast model.');
    return { complexity: 'SIMPLE', requiredTier: 1, reasons };
  }

  reasons.push('Moderate task: default capability tier applies.');
  return { complexity: 'MODERATE', requiredTier: 1, reasons };
}

// ---------------------------------------------------------------------------
// Historical evidence (internal quality signals only)
// ---------------------------------------------------------------------------

/** One recorded historical outcome for a (purpose, model) pair. */
export interface ModelOutcomeRecord {
  model: string;
  purpose: string;
  success: boolean;
}

export interface ModelEvidence {
  model: string;
  purpose: string;
  attempts: number;
  successes: number;
  successRate: number | null; // null when attempts === 0
}

/** Aggregate internal outcomes for a (purpose, model) pair. */
export function aggregateModelEvidence(
  records: ModelOutcomeRecord[],
  model: string,
  purpose: string,
): ModelEvidence {
  const relevant = records.filter((r) => r.model === model && r.purpose === purpose);
  const successes = relevant.filter((r) => r.success).length;
  return {
    model,
    purpose,
    attempts: relevant.length,
    successes,
    successRate: relevant.length === 0 ? null : successes / relevant.length,
  };
}

// ---------------------------------------------------------------------------
// Model candidates (from the existing price table; extended per-model tiering)
// ---------------------------------------------------------------------------

export interface ModelCandidate {
  model: string;
  provider: AiProviderId;
  tier: ModelTier;
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Candidate table. Mirrors the isolated price table in models.ts and adds the
 * capability tier per model. New models must be added HERE AND in the price
 * table together — a mismatch is a configuration bug this module refuses to
 * paper over (unknown models are excluded, never guessed).
 */
const MODEL_CANDIDATES: ModelCandidate[] = [
  { model: 'gemini-2.5-flash', provider: 'gemini', tier: 2, inputPer1M: 0.3, outputPer1M: 2.5 },
  { model: 'gpt-4o-mini', provider: 'openai', tier: 1, inputPer1M: 0.15, outputPer1M: 0.6 },
];

export interface ModelSelection {
  model: string;
  provider: AiProviderId;
  tier: ModelTier;
  complexity: TaskComplexity;
  /** Why this model was chosen (deterministic reasons). */
  reasons: string[];
  /** Historical internal evidence for the chosen model, when it exists. */
  evidence: ModelEvidence | null;
  /** 'NO_EVIDENCE' when nothing internal is known about the chosen model. */
  evidenceStatus: 'INTERNAL_EVIDENCE' | 'NO_EVIDENCE';
  /** Estimated USD cost for the planned call (input estimate + output budget). */
  estimatedCostUsd: number;
}

export interface SelectModelInput {
  signals: ComplexitySignals;
  /** Models allowed by the caller's purpose policy (e.g. env overrides). */
  allowedModels?: string[];
  /** Historical outcomes (internal only; never external benchmarks). */
  history?: ModelOutcomeRecord[];
  /** Planned output token budget for cost estimation. */
  plannedOutputTokens: number;
}

/**
 * Select the lowest-cost suitable model:
//   1. assess complexity → required tier
//   2. filter candidates to tier >= required AND allowed by policy
//   3. apply internal evidence: models with recorded failures are deprioritized
//   4. pick the cheapest surviving candidate by estimated cost
 */
export function selectModel(input: SelectModelInput): ModelSelection {
  const assessment = assessComplexity(input.signals);
  const allowed = new Set(
    (input.allowedModels && input.allowedModels.length > 0 ? input.allowedModels : MODEL_CANDIDATES.map((c) => c.model)),
  );

  const candidates = MODEL_CANDIDATES.filter(
    (c) => c.tier >= assessment.requiredTier && allowed.has(c.model),
  );

  if (candidates.length === 0) {
    // No tiered candidate is available: the conservative answer is to keep the
    // default policy model (resolved by the caller via getModelPolicy). This
    // module never invents a model name.
    return {
      model: 'default-policy-model',
      provider: 'gemini',
      tier: assessment.requiredTier,
      complexity: assessment.complexity,
      reasons: [...assessment.reasons, 'No tiered candidate matched the policy allow-list; the purpose default policy model stays authoritative.'],
      evidence: null,
      evidenceStatus: 'NO_EVIDENCE',
      estimatedCostUsd: 0,
    };
  }

  const costOf = (c: ModelCandidate): number =>
    (input.signals.estimatedInputTokens / 1_000_000) * c.inputPer1M +
    (input.plannedOutputTokens / 1_000_000) * c.outputPer1M;

  const withEvidence = candidates.map((c) => ({
    candidate: c,
    evidence: aggregateModelEvidence(input.history ?? [], c.model, input.signals.purpose),
  }));

  // Evidence-aware ordering: proven-failing models (successRate 0 with >= 2
  // attempts) are excluded; everything else ranks by estimated cost. Models
  // with NO evidence are NOT penalized — absence of evidence is not failure.
  const usable = withEvidence.filter(
    (e) => !(e.evidence.attempts >= 2 && e.evidence.successes === 0),
  );
  const pool = usable.length > 0 ? usable : withEvidence;
  pool.sort((a, b) => costOf(a.candidate) - costOf(b.candidate));

  const chosen = pool[0];
  const reasons = [
    ...assessment.reasons,
    `Selected tier-${chosen.candidate.tier} model ${chosen.candidate.model} as the lowest-cost candidate meeting the required capability.`,
  ];
  if (chosen.evidence.attempts > 0) {
    reasons.push(
      `Internal evidence: ${chosen.evidence.successes}/${chosen.evidence.attempts} successful prior calls for this purpose.`,
    );
  } else {
    reasons.push('No internal evidence exists for this model+purpose; cost-based selection used (NO_EVIDENCE).');
  }

  return {
    model: chosen.candidate.model,
    provider: chosen.candidate.provider,
    tier: chosen.candidate.tier,
    complexity: assessment.complexity,
    reasons,
    evidence: chosen.evidence.attempts > 0 ? chosen.evidence : null,
    evidenceStatus: chosen.evidence.attempts > 0 ? 'INTERNAL_EVIDENCE' : 'NO_EVIDENCE',
    estimatedCostUsd:
      Math.round(costOf(chosen.candidate) * 1_000_000) / 1_000_000,
  };
}

/** Test seam: the candidate table (for asserting router behavior). */
export function __modelCandidates(): readonly ModelCandidate[] {
  return MODEL_CANDIDATES;
}
