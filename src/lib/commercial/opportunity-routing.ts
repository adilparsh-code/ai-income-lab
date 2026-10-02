// ============================================================================
// PHASE 11.3 — OPPORTUNITY ROUTING + DETERMINISTIC SCORING (pure)
// ============================================================================
// Routes a validated opportunity to exactly ONE of the three income engines and
// scores it with explainable, deterministic, evidence-aware arithmetic.
//
// Pure module: no DB, no network, no AI provider.
//
// Hard invariants (docs/phase-11-design.md §16, §17, §23):
// - ALL THREE ROUTES reuse the SAME Job Runner / AgentRun / Supervisor /
//   Revenue / Learning machinery. Routing chooses a workflow; it never
//   creates a parallel orchestration system.
// - NO FABRICATED MARKET NUMBERS. A dimension with no evidence is UNVERIFIED
//   and is EXCLUDED from the composite — it is never defaulted to an optimistic
//   or pessimistic guess.
// - HALAL SCREENING IS CONSERVATIVE. BLOCKED wins over everything; ambiguous
//   input yields REVIEW_REQUIRED, never HALAL. This is operational screening,
//   not a religious ruling.
// - External content is UNTRUSTED DATA. It can produce a candidate route, never
//   authority to execute.
// ============================================================================

import { screenForHalalCompliance } from '@/lib/halal-filter';
import { OFFER_TYPES, isOfferType, type OfferType } from './offer-states';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export const ROUTES = ['DIGITAL_PRODUCT_WORKFLOW', 'MICRO_SERVICE_WORKFLOW', 'CLIENT_SERVICE_WORKFLOW'] as const;
export type Route = (typeof ROUTES)[number];

export function isRoute(value: unknown): value is Route {
  return typeof value === 'string' && (ROUTES as readonly string[]).includes(value);
}

/** Deterministic mapping from an offer type to its execution workflow. */
export const OFFER_TYPE_TO_ROUTE: Readonly<Record<OfferType, Route>> = {
  DIGITAL_PRODUCT: 'DIGITAL_PRODUCT_WORKFLOW',
  MICRO_SERVICE: 'MICRO_SERVICE_WORKFLOW',
  CLIENT_SERVICE: 'CLIENT_SERVICE_WORKFLOW',
};

/**
 * The engine kinds that execute each route. Every one of them is an EXISTING
 * job type or a narrowly-scoped Phase 11.3 service job handled by the SAME Job
 * Runner (job-runner.ts). No new orchestration system exists.
 */
export const ROUTE_JOB_TYPES: Readonly<Record<Route, readonly string[]>> = {
  // Reuses the existing Product Factory job types verbatim.
  DIGITAL_PRODUCT_WORKFLOW: ['PRODUCT_CREATE', 'PRODUCT_BUILD', 'PRODUCT_TEST', 'PRODUCT_DEPLOY', 'PRODUCT_PUBLISH'],
  // Bounded micro-service execution through the service job path.
  MICRO_SERVICE_WORKFLOW: ['SERVICE_BUILD', 'SERVICE_QA', 'SERVICE_DELIVERY'],
  // Bounded client-service execution through the same service job path.
  CLIENT_SERVICE_WORKFLOW: ['SERVICE_BUILD', 'SERVICE_QA', 'SERVICE_DELIVERY'],
};

/** The single structural difference: how a sale is concluded. */
export const ROUTE_COMMERCIAL_SHAPE: Readonly<Record<Route, 'SELF_SERVE' | 'PROPOSAL'>> = {
  DIGITAL_PRODUCT_WORKFLOW: 'SELF_SERVE',
  MICRO_SERVICE_WORKFLOW: 'PROPOSAL',
  CLIENT_SERVICE_WORKFLOW: 'PROPOSAL',
};

export interface RoutingDecision {
  route: Route;
  offerType: OfferType;
  jobTypes: readonly string[];
  commercialShape: 'SELF_SERVE' | 'PROPOSAL';
  /** Why this route was chosen — always explicit, never guessed silently. */
  reason: string;
  /** False when the opportunity is not yet good enough to execute. */
  executable: boolean;
  blockers: string[];
}

/**
 * Deterministically route an opportunity. The offer type is an INPUT DECLARED
 * BY A HUMAN/ADMIN (or by the opportunity's businessModel), never inferred
 * from untrusted content.
 */
export function routeOpportunity(input: {
  offerType: unknown;
  /** Deterministic halal verdict already recorded on the opportunity. */
  opportunityHalalStatus?: string;
  requiresProspect?: boolean;
}): RoutingDecision {
  if (!isOfferType(input.offerType)) {
    return {
      route: 'CLIENT_SERVICE_WORKFLOW',
      offerType: 'CLIENT_SERVICE',
      jobTypes: ROUTE_JOB_TYPES.CLIENT_SERVICE_WORKFLOW,
      commercialShape: 'PROPOSAL',
      reason: 'Unrecognized offer type; refusing to guess. Refused pending an explicit offer type.',
      executable: false,
      blockers: ['INVALID_OFFER_TYPE'],
    };
  }
  const offerType: OfferType = input.offerType;
  const route = OFFER_TYPE_TO_ROUTE[offerType];
  const blockers: string[] = [];

  // Conservative: any non-HALAL screening verdict blocks autonomous routing.
  const status = input.opportunityHalalStatus ?? 'UNVERIFIED';
  if (status === 'NOT_ALLOWED') blockers.push('HALAL_BLOCKED');
  else if (status === 'REVIEW_REQUIRED') blockers.push('HALAL_REVIEW_REQUIRED');
  else if (status !== 'HALAL') blockers.push('HALAL_UNVERIFIED');

  const needsProspect = input.requiresProspect ?? (offerType !== 'DIGITAL_PRODUCT');
  if (needsProspect && offerType === 'DIGITAL_PRODUCT') {
    blockers.push('DIGITAL_PRODUCT_SHOULD_NOT_REQUIRE_A_PROSPECT');
  }

  return {
    route,
    offerType,
    jobTypes: ROUTE_JOB_TYPES[route],
    commercialShape: ROUTE_COMMERCIAL_SHAPE[route],
    reason:
      `${offerType} maps deterministically to ${route}; execution reuses the existing Job Runner `
      + `job types [${ROUTE_JOB_TYPES[route].join(', ')}].`,
    executable: blockers.length === 0,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Discovery candidates with provenance
// ---------------------------------------------------------------------------

export const CANDIDATE_KINDS = [
  'MARKET_OPPORTUNITY',
  'PRODUCT_OPPORTUNITY',
  'MICRO_SERVICE_OPPORTUNITY',
  'CLIENT_SERVICE_PROSPECT',
] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export function isCandidateKind(value: unknown): value is CandidateKind {
  return typeof value === 'string' && (CANDIDATE_KINDS as readonly string[]).includes(value);
}

/** Confidence is a bounded 0..1 value; unknown confidence is null, not 0.5. */
export const MAX_CANDIDATES = 50;

export interface DiscoveryCandidate {
  kind: CandidateKind;
  title: string;
  summary: string;
  /** Suggested offer type — a suggestion only; never auto-applied. */
  suggestedOfferType: OfferType;
  // Mandatory provenance on every candidate. A candidate without a source is
  // rejected by validateCandidate, never stored.
  source: string;
  sourceRef: string;
  evidence: string;
  evidenceType: 'VERIFIED_DATA' | 'SEARCH_DISCOVERY' | 'UNVERIFIED';
  retrievedAt: string;
  confidence: number | null;
}

export type CandidateValidation =
  | { ok: true; value: DiscoveryCandidate }
  | { ok: false; reason: string };

/**
 * Validate one discovery candidate. Evidence provenance is MANDATORY: a
 * candidate with no source, no sourceRef, or no evidence is rejected, so a
 * fabricated "market opportunity" can never enter the pipeline.
 */
export function validateCandidate(raw: unknown, now: () => Date = () => new Date()): CandidateValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'Candidate must be an object.' };
  }
  const record = raw as Record<string, unknown>;
  if (!isCandidateKind(record.kind)) {
    return { ok: false, reason: `kind must be one of: ${CANDIDATE_KINDS.join(', ')}.` };
  }
  if (typeof record.title !== 'string' || record.title.trim().length === 0 || record.title.length > 300) {
    return { ok: false, reason: 'title is required (at most 300 characters).' };
  }
  if (typeof record.summary !== 'string' || record.summary.length > 2_000) {
    return { ok: false, reason: 'summary must be a string of at most 2000 characters.' };
  }
  if (!isOfferType(record.suggestedOfferType)) {
    return { ok: false, reason: `suggestedOfferType must be one of: ${OFFER_TYPES.join(', ')}.` };
  }
  // Provenance is mandatory — never fabricated, never empty.
  if (typeof record.source !== 'string' || record.source.trim().length === 0 || record.source.length > 120) {
    return { ok: false, reason: 'source is required (provenance — never fabricated).' };
  }
  if (typeof record.sourceRef !== 'string' || record.sourceRef.trim().length === 0 || record.sourceRef.length > 500) {
    return { ok: false, reason: 'sourceRef is required (provenance — never fabricated).' };
  }
  if (typeof record.evidence !== 'string' || record.evidence.trim().length === 0 || record.evidence.length > 2_000) {
    return { ok: false, reason: 'evidence is required (provenance — never fabricated).' };
  }
  const evidenceType = record.evidenceType ?? 'UNVERIFIED';
  if (!['VERIFIED_DATA', 'SEARCH_DISCOVERY', 'UNVERIFIED'].includes(String(evidenceType))) {
    return { ok: false, reason: 'evidenceType must be VERIFIED_DATA, SEARCH_DISCOVERY, or UNVERIFIED.' };
  }
  let confidence: number | null = null;
  if (record.confidence !== undefined && record.confidence !== null) {
    if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      return { ok: false, reason: 'confidence must be a number between 0 and 1, or omitted.' };
    }
    confidence = record.confidence;
  }
  return {
    ok: true,
    value: {
      kind: record.kind,
      title: record.title.trim(),
      summary: record.summary,
      suggestedOfferType: record.suggestedOfferType as OfferType,
      source: record.source.trim(),
      sourceRef: record.sourceRef.trim(),
      evidence: record.evidence.trim(),
      evidenceType: evidenceType as DiscoveryCandidate['evidenceType'],
      retrievedAt: typeof record.retrievedAt === 'string' && !Number.isNaN(Date.parse(record.retrievedAt))
        ? record.retrievedAt
        : now().toISOString(),
      confidence,
    },
  };
}

/** Batch validation with a hard cap; malformed candidates are dropped, not stored. */
export function validateCandidates(raw: unknown, now: () => Date = () => new Date()): {
  candidates: DiscoveryCandidate[];
  rejected: { index: number; reason: string }[];
  truncated: boolean;
} {
  if (!Array.isArray(raw)) return { candidates: [], rejected: [], truncated: false };
  const candidates: DiscoveryCandidate[] = [];
  const rejected: { index: number; reason: string }[] = [];
  const truncated = raw.length > MAX_CANDIDATES;
  for (const [index, entry] of raw.slice(0, MAX_CANDIDATES).entries()) {
    const result = validateCandidate(entry, now);
    if (result.ok) candidates.push(result.value);
    else rejected.push({ index, reason: result.reason });
  }
  return { candidates, rejected, truncated };
}

/**
 * Provider-not-connected truthfulness. When no discovery provider is wired,
 * discovery returns an honest NOT_CONNECTED result and ZERO candidates — never
 * a fabricated "no opportunities found" list presented as real data.
 */
export function discoveryUnavailable(health: { status: string; hint?: string }): {
  state: 'NOT_CONNECTED';
  candidates: [];
  detail: string;
} {
  return {
    state: 'NOT_CONNECTED',
    candidates: [],
    detail:
      `Discovery provider unavailable (${health.status}). No candidates were returned and none were fabricated. `
      + (health.hint ?? 'Configure RESEARCH_SEARCH_PROVIDER to enable external discovery.'),
  };
}

// ---------------------------------------------------------------------------
// Deterministic opportunity scoring — evidence-aware, never fabricated
// ---------------------------------------------------------------------------

export const SCORE_DIMENSIONS = [
  'demand',
  'competition',
  'differentiation',
  'effort',
  'cost',
  'pricePotential',
  'margin',
  'executionFeasibility',
  'distributionDifficulty',
  'risk',
  'evidenceStrength',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

export function isScoreDimension(value: unknown): value is ScoreDimension {
  return typeof value === 'string' && (SCORE_DIMENSIONS as readonly string[]).includes(value);
}

/** A dimension value: either an evidence-backed number, or explicitly UNVERIFIED. */
export type DimensionValue =
  | { state: 'VERIFIED'; value: number; evidenceRef: string }
  | { state: 'UNVERIFIED' };

export interface ScoreInput {
  dimensions: Partial<Record<ScoreDimension, unknown>>;
  /** Free text screened through the EXISTING halal filter. Untrusted. */
  title: string;
  description: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  /** The screening verdict already recorded on the opportunity row, if any. */
  recordedHalalStatus?: string;
}

/** Weights are fixed, published in code, and identical for every opportunity. */
export const SCORE_WEIGHTS: Readonly<Record<ScoreDimension, number>> = {
  demand: 2,
  competition: 1,
  differentiation: 2,
  effort: 1,
  cost: 1,
  pricePotential: 2,
  margin: 2,
  executionFeasibility: 2,
  distributionDifficulty: 1,
  risk: 1,
  evidenceStrength: 2,
};

export type OpportunityHalalClassification = 'HALAL' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'UNVERIFIED';

export interface OpportunityScore {
  /** Composite over VERIFIED dimensions only; null when nothing is verified. */
  composite: number | null;
  /** How many dimensions actually had evidence — the honesty counter. */
  verifiedDimensionCount: number;
  unverifiedDimensionCount: number;
  dimensions: Record<ScoreDimension, DimensionValue>;
  /** Per-dimension contribution to the composite, for explainability. */
  contributions: Record<ScoreDimension, number | null>;
  halalClassification: OpportunityHalalClassification;
  halalReasons: string[];
  /** True when any market figure would have been invented to complete a score. */
  hasUnverifiedDimensions: boolean;
  note: string;
}

const MAX_DIMENSION_VALUE = 100;

/**
 * Deterministic scoring. Two properties matter more than the arithmetic:
 *  1. A dimension with no evidence is UNVERIFIED and contributes NOTHING —
 *     it is not imputed, not defaulted, not guessed.
 *  2. Halal classification is conservative: BLOCKED beats REVIEW_REQUIRED
 *     beats UNVERIFIED beats HALAL, and an unscreened opportunity is UNVERIFIED
 *     rather than HALAL.
 */
export function scoreOpportunity(input: ScoreInput): OpportunityScore {
  const dimensions = {} as Record<ScoreDimension, DimensionValue>;
  const contributions = {} as Record<ScoreDimension, number | null>;

  let verified = 0;
  let unverified = 0;
  let weightedSum = 0;
  let weightTotal = 0;

  for (const dimension of SCORE_DIMENSIONS) {
    const raw = input.dimensions[dimension];
    const parsed = parseDimension(raw);
    dimensions[dimension] = parsed;
    if (parsed.state === 'VERIFIED') {
      verified += 1;
      const weight = SCORE_WEIGHTS[dimension];
      weightedSum += parsed.value * weight;
      weightTotal += weight;
      contributions[dimension] = Math.round((parsed.value * weight) * 100) / 100;
    } else {
      unverified += 1;
      contributions[dimension] = null;
    }
  }

  const composite = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null;

  const screening = screenForHalalCompliance(
    input.title,
    input.description,
    input.category,
    input.businessModel,
    input.monetizationMethod,
  );
  const { classification, reasons } = classifyHalal(screening.status, input.recordedHalalStatus, screening.reasons);

  return {
    composite,
    verifiedDimensionCount: verified,
    unverifiedDimensionCount: unverified,
    dimensions,
    contributions,
    halalClassification: classification,
    halalReasons: reasons,
    hasUnverifiedDimensions: unverified > 0,
    note:
      composite === null
        ? 'No dimension had evidence, so no composite score was produced. No market number was invented.'
        : `Composite covers only the ${verified} evidence-backed dimension(s); the ${unverified} UNVERIFIED dimension(s) were excluded, never imputed. `
          + 'Screening is an operational control, not a religious ruling.',
  };
}

/**
 * Conservative halal classification. The WORST input wins, and an absent
 * recorded verdict downgrades to UNVERIFIED rather than assuming HALAL.
 */
export function classifyHalal(
  screenStatus: string,
  recordedStatus: string | undefined,
  screenReasons: readonly string[],
): { classification: OpportunityHalalClassification; reasons: string[] } {
  const reasons = [...screenReasons].slice(0, 10);
  const candidates: OpportunityHalalClassification[] = [];

  if (screenStatus === 'NOT_ALLOWED') candidates.push('BLOCKED');
  else if (screenStatus === 'REVIEW_REQUIRED') candidates.push('REVIEW_REQUIRED');
  else if (screenStatus === 'HALAL') candidates.push('HALAL');
  else candidates.push('UNVERIFIED');

  if (recordedStatus === 'NOT_ALLOWED') candidates.push('BLOCKED');
  else if (recordedStatus === 'REVIEW_REQUIRED') candidates.push('REVIEW_REQUIRED');
  else if (recordedStatus === undefined || recordedStatus === '') candidates.push('UNVERIFIED');
  else if (recordedStatus === 'HALAL') candidates.push('HALAL');

  const rank: Record<OpportunityHalalClassification, number> = {
    BLOCKED: 3, REVIEW_REQUIRED: 2, UNVERIFIED: 1, HALAL: 0,
  };
  const classification = candidates.reduce((worst, c) => (rank[c] > rank[worst] ? c : worst), 'HALAL' as OpportunityHalalClassification);
  if (classification === 'UNVERIFIED') {
    reasons.push('No screening verdict was recorded; treated as UNVERIFIED rather than assumed compliant.');
  }
  return { classification, reasons };
}

function parseDimension(raw: unknown): DimensionValue {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { state: 'UNVERIFIED' };
  if (raw < 0 || raw > MAX_DIMENSION_VALUE) return { state: 'UNVERIFIED' };
  return { state: 'VERIFIED', value: raw, evidenceRef: 'CALLER_SUPPLIED' };
}

/**
 * Translate a score into the routing decision it permits. A BLOCKED or
 * UNVERIFIED-halal opportunity is never executable, regardless of score.
 */
export function executionVerdict(score: OpportunityScore, routing: RoutingDecision): {
  executable: boolean;
  verdict: 'PROCEED' | 'PAUSE' | 'QUARANTINE';
  reasons: string[];
} {
  const reasons: string[] = [];
  if (score.halalClassification === 'BLOCKED') {
    return { executable: false, verdict: 'QUARANTINE', reasons: ['Blocked by halal screening.'] };
  }
  if (score.halalClassification === 'REVIEW_REQUIRED') {
    reasons.push('Halal screening requires human review before any execution.');
  }
  if (score.halalClassification === 'UNVERIFIED') {
    reasons.push('Halal status is UNVERIFIED; conservative screening forbids autonomous execution.');
  }
  for (const blocker of routing.blockers) reasons.push(`Routing blocker: ${blocker}.`);
  if (routing.blockers.includes('HALAL_BLOCKED')) {
    return { executable: false, verdict: 'QUARANTINE', reasons };
  }
  const hasHumanGate = score.halalClassification === 'REVIEW_REQUIRED' || routing.blockers.length > 0;
  return {
    executable: !hasHumanGate && routing.executable,
    verdict: hasHumanGate ? 'PAUSE' : 'PROCEED',
    reasons: reasons.length > 0 ? reasons : ['All gates passed deterministically.'],
  };
}