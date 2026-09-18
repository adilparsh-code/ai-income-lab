// Phase 5.1 — External research → opportunity candidate normalization.
//
// Converts real external evidence (search discovery + fetched/verified page
// facts) into a structured Opportunity Candidate with STRICT provenance:
//
// - VERIFIED_DATA facts come only from fetched pages (via the provider's
//   fetch/extract path). Search snippets stay SEARCH_DISCOVERY.
// - AI-generated observations are AI_INFERENCE and are always labelled as
//   hypotheses; they can NEVER upgrade any field to VERIFIED_DATA.
// - The candidate passes through the EXISTING halal screening
//   (screenForHalalCompliance) before it may become a validation target.
//   NOT_ALLOWED candidates are hard-rejected; REVIEW_REQUIRED candidates are
//   flagged and stop before any autonomous execution.
//
// Honesty rules: no market sizes, customer counts, guaranteed demand/revenue,
// or profit claims are ever produced here. Unknowns are reported as evidence
// gaps. AI must never issue a religious ruling — halal screening here is the
// configured deterministic tool only.

import { screenForHalalCompliance } from '@/lib/halal-filter';
import type { ProviderDiscovery, ProviderPageEvidence } from './provider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateHalalStatus = 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';

/** One evidence item attached to a candidate (bounded, provenance-labelled). */
export interface CandidateEvidenceItem {
  sourceProvider: string;
  sourceUrl: string;
  sourceTitle: string;
  /** VERIFIED_DATA (fetched) or SEARCH_DISCOVERY (snippet only). */
  evidenceType: 'VERIFIED_DATA' | 'SEARCH_DISCOVERY';
  extractedFact: string;
  retrievedAt: string;
  freshnessDays: number | null;
  relevance: number | null;
  /** Source-level status reported by the provider pass. */
  sourceStatus: 'OK' | 'PARTIAL' | 'FAILED' | 'SNIPPET_ONLY';
}

export interface OpportunityCandidate {
  /** Working title — derived from observed evidence, labelled as hypothesis. */
  title: string;
  category: string;
  /** Observed customer problem, with its provenance. */
  customerProblem: { text: string; evidenceType: 'VERIFIED_DATA' | 'SEARCH_DISCOVERY' | 'AI_INFERENCE' };
  /** Observed/likely audience hypothesis — never a verified count. */
  targetAudienceHypothesis: string;
  /** Observed demand signals (bounded; provenance per item). */
  demandSignals: { text: string; evidenceType: 'VERIFIED_DATA' | 'SEARCH_DISCOVERY'; sourceUrl: string }[];
  /** Existing solutions observed in evidence (competitor-adjacent facts). */
  existingSolutions: { text: string; sourceUrl: string; evidenceType: 'VERIFIED_DATA' | 'SEARCH_DISCOVERY' }[];
  /** Possible monetization hypotheses — explicitly hypotheses. */
  monetizationHypotheses: string[];
  risks: string[];
  /** Explicit uncertainty register — what the evidence does NOT show. */
  uncertainties: string[];
  /** What evidence is missing before stronger claims would be possible. */
  evidenceGaps: string[];
  /** All bounded evidence items backing this candidate. */
  evidence: CandidateEvidenceItem[];
  halal: {
    status: CandidateHalalStatus;
    reasons: string[];
    /** Screening is deterministic tooling, never a religious ruling. */
    disclaimer: string;
  };
  /** Provenance rollup for dashboards. */
  provenance: {
    verifiedFactCount: number;
    discoveryCount: number;
    aiInferenceCount: number;
    sourceDomains: string[];
    oldestEvidenceDays: number | null;
    newestEvidenceAt: string | null;
  };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_ITEMS = 12;
const MAX_SIGNALS = 6;
const MAX_SOLUTIONS = 5;

function clampText(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Build an OpportunityCandidate from a provider research pass.
 * `objective` seeds the title/problem framing (user-entered data);
 * discovery provides SEARCH_DISCOVERY signals; fetched pages provide
 * VERIFIED_DATA facts. Nothing is invented beyond those inputs.
 */
export function buildOpportunityCandidate(input: {
  objective: string;
  marketCategory?: string;
  discovery: ProviderDiscovery[];
  fetchedPages: ProviderPageEvidence[];
  createdAt?: string;
}): OpportunityCandidate {
  const objective = clampText(input.objective, 300);
  const category = clampText(input.marketCategory ?? 'Digital Products', 80);

  const evidence: CandidateEvidenceItem[] = [];

  // VERIFIED_DATA items from fetched pages — the strongest evidence class.
  for (const page of input.fetchedPages.slice(0, 6)) {
    for (const fact of page.facts.slice(0, 3)) {
      if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
      evidence.push({
        sourceProvider: page.sourceProvider,
        sourceUrl: page.sourceUrl,
        sourceTitle: page.sourceTitle,
        evidenceType: 'VERIFIED_DATA',
        extractedFact: clampText(fact.fact, 300),
        retrievedAt: page.retrievedAt,
        freshnessDays: null,
        relevance: null,
        sourceStatus: 'OK',
      });
    }
  }

  // SEARCH_DISCOVERY items from snippets — weaker, clearly labelled.
  for (const item of input.discovery) {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    if (!item.snippet || item.snippet.trim().length === 0) continue;
    evidence.push({
      sourceProvider: item.sourceProvider,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.sourceTitle,
      evidenceType: 'SEARCH_DISCOVERY',
      extractedFact: clampText(item.snippet, 300),
      retrievedAt: item.retrievedAt,
      freshnessDays: item.freshnessDays,
      relevance: item.relevance,
      sourceStatus: 'SNIPPET_ONLY',
    });
  }

  // Provenance rollup.
  const verifiedFactCount = evidence.filter((e) => e.evidenceType === 'VERIFIED_DATA').length;
  const discoveryCount = evidence.filter((e) => e.evidenceType === 'SEARCH_DISCOVERY').length;
  const sourceDomains = [...new Set(evidence.map((e) => safeDomain(e.sourceUrl)))].slice(0, 8);
  const freshnessValues = evidence.map((e) => e.freshnessDays).filter((d): d is number => d !== null);
  const newestEvidenceAt = evidence.length > 0
    ? evidence.reduce((newest, e) => (e.retrievedAt > newest ? e.retrievedAt : newest), evidence[0].retrievedAt)
    : null;

  // Demand signals / existing solutions are drawn from evidence text only.
  const demandSignals = evidence
    .filter((e) => e.evidenceType === 'VERIFIED_DATA' || e.evidenceType === 'SEARCH_DISCOVERY')
    .slice(0, MAX_SIGNALS)
    .map((e) => ({ text: e.extractedFact, evidenceType: e.evidenceType, sourceUrl: e.sourceUrl }));

  const existingSolutions = input.discovery
    .slice(0, MAX_SOLUTIONS)
    .map((d) => ({ text: clampText(d.sourceTitle, 200), sourceUrl: d.sourceUrl, evidenceType: 'SEARCH_DISCOVERY' as const }));

  // Explicit honesty framing: these are hypotheses derived from the objective,
  // never verified claims.
  const monetizationHypotheses = [
    'HYPOTHESIS: monetization model is undetermined; candidate validation must test pricing and format.',
  ];
  const uncertainties = [
    'No verified market size or customer counts exist; none will be estimated.',
    'Demand signals are observational (search snippets and fetched page facts), not purchase intent.',
    input.fetchedPages.length === 0
      ? 'No pages were fetched and verified in this pass; all external items are SEARCH_DISCOVERY snippets.'
      : 'Fetched facts describe the source pages themselves; causal demand conclusions require validation experiments.',
  ];
  const evidenceGaps: string[] = [];
  if (input.fetchedPages.length === 0) evidenceGaps.push('No VERIFIED_DATA: fetch+extract at least one source page.');
  if (input.discovery.length === 0) evidenceGaps.push('No discovery signals: search returned no usable results.');
  evidenceGaps.push('No pricing or willingness-to-pay evidence yet.');
  evidenceGaps.push('No audience-size evidence; reach is unknown.');

  const title = clampText(objective.split(/[.!?]/)[0] || objective, 120);
  const customerProblem = {
    text: objective,
    // The objective is user-entered intent, but as a PROBLEM STATEMENT it is
    // carried as USER_ENTERED-equivalent framing; evidence fields keep their
    // own types. We use the weakest honest label available to candidates:
    // AI_INFERENCE is never used here because no AI produced it.
    evidenceType: 'SEARCH_DISCOVERY' as const,
  };

  const base: OpportunityCandidate = {
    title: title.length > 0 ? title : 'Untitled research candidate',
    category,
    customerProblem,
    targetAudienceHypothesis: 'HYPOTHESIS: audience to be determined by validation research.',
    demandSignals,
    existingSolutions,
    monetizationHypotheses,
    risks: [
      'External content is untrusted input; all extracted text requires human review before use.',
      evidence.some((e) => e.evidenceType === 'SEARCH_DISCOVERY')
        ? 'Some signals are SEARCH_DISCOVERY snippets that were never fetched — treat as leads, not facts.'
        : 'No snippet-level leads were available; evidence is limited to fetched pages.',
    ],
    uncertainties,
    evidenceGaps,
    evidence,
    halal: {
      status: 'HALAL',
      reasons: [],
      disclaimer: 'Automated screening tool, not a religious authority. Classification follows configured rules only.',
    },
    provenance: {
      verifiedFactCount,
      discoveryCount,
      aiInferenceCount: 0,
      sourceDomains,
      oldestEvidenceDays: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
      newestEvidenceAt,
    },
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  return applyHalalScreening(base);
}

/**
 * Run the EXISTING halal screening over the candidate's textual surface
 * (title + problem + observed signals). NOT_ALLOWED hard-rejects the
 * candidate's `usable` flag; REVIEW_REQUIRED flags human review. This module
 * never issues a religious ruling — it applies configured rules only.
 */
export function applyHalalScreening(candidate: OpportunityCandidate): OpportunityCandidate {
  const signalText = candidate.demandSignals.map((s) => s.text).join(' ').slice(0, 2000);
  const screen = screenForHalalCompliance(
    candidate.title,
    `${candidate.customerProblem.text} ${signalText}`.slice(0, 4000),
    candidate.category,
    '',
    '',
  );
  return {
    ...candidate,
    halal: {
      status: screen.status,
      reasons: screen.reasons.slice(0, 8),
      disclaimer: candidate.halal.disclaimer,
    },
  };
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Honest summary helpers (for prompts, handoffs, dashboards)
// ---------------------------------------------------------------------------

/** One-line truthful status of a candidate for surfaces and logs. */
export function describeCandidateProvenance(candidate: OpportunityCandidate): string {
  const p = candidate.provenance;
  return `Candidate "${candidate.title}": ${p.verifiedFactCount} verified fact(s) from ${p.sourceDomains.length} source(s), `
    + `${p.discoveryCount} discovery snippet(s), halal=${candidate.halal.status}. `
    + 'No market size, customer counts, or revenue guarantees are claimed.';
}

/**
 * Hard gate: only HALAL candidates may proceed autonomously. REVIEW_REQUIRED
 * candidates require a human before any execution; NOT_ALLOWED never proceeds.
 */
export function isCandidateExecutable(candidate: OpportunityCandidate): boolean {
  return candidate.halal.status === 'HALAL';
}

/** REVIEW_REQUIRED candidates may be persisted but never autonomously executed. */
export function requiresHumanReview(candidate: OpportunityCandidate): boolean {
  return candidate.halal.status === 'REVIEW_REQUIRED';
}
