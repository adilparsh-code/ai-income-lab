// Server-only Research Agent generation helpers (Phase 4.2.2).
//
// This module is intentionally PROVIDER-AGNOSTIC. It only composes a prompt,
// defines a structured schema, validates the schema, and maps validated AI
// output into the normalized ResearchResult. It NEVER imports a concrete
// provider adapter. The Research Agent therefore depends on the generic
// generation layer (./generate) and this module — not on Gemini/OpenAI code.
//
// Provenance: every field produced here is AI_INFERENCE. Nothing in this module
// can represent VERIFIED_DATA; external verification is out of scope and never
// fabricated.

import { type AiJsonSchema } from './provider';
import type {
  AgentStatus,
  EvidenceType,
  ResearchFinding,
  ResearchResult,
  ResearchSignal,
  ResearchSourceRef,
  ResearchSourceReport,
} from '@/lib/agents/types';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Structured schema
// ---------------------------------------------------------------------------

export const RESEARCH_SCHEMA: AiJsonSchema = {
  required: [
    'summary',
    'demandSignals',
    'audienceHypotheses',
    'painPoints',
    'competitionObservations',
    'monetizationOpportunities',
    'risks',
    'assumptions',
    'validationQuestions',
    'nextAction',
  ],
  properties: {
    summary: 'string',
    demandSignals: 'string[]',
    audienceHypotheses: 'string[]',
    painPoints: 'string[]',
    competitionObservations: 'string[]',
    monetizationOpportunities: 'string[]',
    risks: 'string[]',
    assumptions: 'string[]',
    validationQuestions: 'string[]',
    nextAction: 'string',
  },
};

export interface ResearchAiOutput {
  summary: string;
  demandSignals: string[];
  audienceHypotheses: string[];
  painPoints: string[];
  competitionObservations: string[];
  monetizationOpportunities: string[];
  risks: string[];
  assumptions: string[];
  validationQuestions: string[];
  nextAction: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

export interface ResearchPromptInput {
  researchObjective: string;
  targetAudience?: string;
  marketCategory?: string;
  geography?: string;
  constraints?: string[];
  halalRequirements?: string[];
  opportunity?: {
    id: string;
    title: string;
    status?: string;
    halalStatus: string;
    problemSolved?: string;
    overallScore?: number;
  } | null;
  halalConsiderations: string[];
  /** Real-research evidence context (discovery + verified fetches), if any. */
  evidenceContext?: string;
}

const EXAMPLE_SHAPE: Record<keyof ResearchAiOutput, string | string[]> = {
  summary: 'Two-sentence summary of the opportunity.',
  demandSignals: ['Evidence-of-demand type signal.'],
  audienceHypotheses: ['Who is likely to buy and why.'],
  painPoints: ['A concrete pain point worth solving.'],
  competitionObservations: ['An observable competitive dynamic.'],
  monetizationOpportunities: ['A monetization angle to explore.'],
  risks: ['A key risk or assumption failure mode.'],
  assumptions: ['An assumption your analysis depends on.'],
  validationQuestions: ['A question that would invalidate or confirm the thesis.'],
  nextAction: 'The single most valuable next validation step.',
};

export function buildResearchPrompt(input: ResearchPromptInput): string {
  const lines: string[] = [];
  lines.push('You are a market researcher for a halal-conscious business. Produce a structured research briefing.');
  lines.push(
    'OUTPUT_CONTRACT: All of your output is AI INFERENCE, not verified external data. Never claim you verified facts ' +
      'from the live web unless you actually did. Distinguish clearly between an observed trend and a hypothesis.'
  );
  lines.push(
    'HALAL_GATE: If the topic itself is clearly impermissible (gambling/betting, adult content, fraud, piracy, ' +
      'deceptive ads, fake reviews, riba/interest-based schemes, ponzi/pyramid, etc.), you MUST say so explicitly in ' +
      '"risks" and set "nextAction" to "BLOCKED_PENDING_REVIEW". Never recommend execution for an impermissible model.'
  );
  lines.push('');
  lines.push(`Research objective: ${input.researchObjective}`);
  if (input.targetAudience) lines.push(`Target audience: ${input.targetAudience}`);
  if (input.marketCategory) lines.push(`Market category: ${input.marketCategory}`);
  if (input.geography) lines.push(`Geography: ${input.geography}`);
  if (input.constraints && input.constraints.length > 0) lines.push(`Constraints: ${input.constraints.join('; ')}`);
  if (input.halalRequirements && input.halalRequirements.length > 0) {
    lines.push(`Halal requirements: ${input.halalRequirements.join('; ')}`);
  }
  if (input.opportunity) {
    lines.push(
      `Opportunity context: title="${input.opportunity.title}" status=${input.opportunity.status ?? 'n/a'} ` +
        `halalStatus=${input.opportunity.halalStatus}`
    );
    if (input.opportunity.problemSolved) lines.push(`Problem it solves: ${input.opportunity.problemSolved}`);
  }
  if (input.halalConsiderations.length > 0) {
    lines.push(`Halal considerations already flagged: ${input.halalConsiderations.join('; ')}`);
  }
  if (input.evidenceContext && input.evidenceContext.trim().length > 0) {
    lines.push('');
    lines.push('Collected web evidence (labels are authoritative — never claim stronger verification than shown):');
    lines.push(input.evidenceContext);
  }
  lines.push('');
  lines.push('Reply with ONLY a JSON object matching exactly this shape (arrays must be arrays of strings):');
  lines.push(JSON.stringify(EXAMPLE_SHAPE, null, 2));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Normalization: validated AI output -> ResearchResult
// ---------------------------------------------------------------------------

export interface BuildResearchResultInput {
  researchObjective: string;
  research: ResearchAiOutput;
  halalConsiderations: string[];
  overallConfidence: number;
  capabilityStatus: AgentStatus;
  isMocked: boolean;
  /** Real-research sources + report (Phase 5.1); empty/null when engine absent. */
  sources?: ResearchSourceRef[];
  sourceResearch?: ResearchSourceReport | null;
}

const INFERENCE: EvidenceType = 'AI_INFERENCE';

export function buildResearchResult(input: BuildResearchResultInput): ResearchResult {
  const findings: ResearchFinding[] = [
    { id: uuidv4(), content: input.research.summary, evidenceType: INFERENCE },
    ...input.research.audienceHypotheses.map((h) => ({ id: uuidv4(), content: `Audience hypothesis: ${h}`, evidenceType: INFERENCE as EvidenceType })),
    ...input.research.painPoints.map((p) => ({ id: uuidv4(), content: `Pain point: ${p}`, evidenceType: INFERENCE as EvidenceType })),
  ];

  const signals: ResearchSignal[] = [
    ...input.research.demandSignals.map((c) => ({ id: uuidv4(), type: 'demand' as const, content: c, confidence: 0.6, evidenceType: INFERENCE, isMocked: input.isMocked })),
    ...input.research.risks.map((c) => ({ id: uuidv4(), type: 'risk' as const, content: c, confidence: 0.6, evidenceType: INFERENCE, isMocked: input.isMocked })),
    ...input.research.monetizationOpportunities.map((c) => ({ id: uuidv4(), type: 'monetization' as const, content: c, confidence: 0.6, evidenceType: INFERENCE, isMocked: input.isMocked })),
    ...input.research.competitionObservations.map((c) => ({ id: uuidv4(), type: 'competitor' as const, content: c, confidence: 0.6, evidenceType: INFERENCE, isMocked: input.isMocked })),
  ];

  const evidenceItems = findings.map((f) => ({ id: f.id, type: f.evidenceType, content: f.content }));

  return {
    researchObjective: input.researchObjective,
    findings,
    signals,
    assumptions: input.research.assumptions,
    risks: input.research.risks,
    competitors: input.research.competitionObservations,
    demandIndicators: input.research.demandSignals,
    monetizationObservations: input.research.monetizationOpportunities,
    halalConsiderations: input.halalConsiderations,
    overallConfidence: input.overallConfidence,
    evidenceItems,
    sources: input.sources ?? [],
    sourceResearch: input.sourceResearch ?? null,
    capabilityStatus: input.capabilityStatus,
  };
}

/**
 * Format real-research sources into a bounded, provenance-labelled prompt
 * context. Labels are authoritative: verified fetches are marked VERIFIED_DATA
 * and discovery is explicitly NOT verified, so the model can never honestly
 * claim more verification than the labels carry.
 */
export function buildEvidenceContext(sources: ResearchSourceRef[]): string {
  if (sources.length === 0) return '';
  const verified = sources.filter((s) => s.evidenceType === 'VERIFIED_DATA');
  const discovery = sources.filter((s) => s.evidenceType === 'SEARCH_DISCOVERY');
  const lines: string[] = [];

  if (verified.length > 0) {
    lines.push('VERIFIED_DATA — fetched from origin:');
    const verifiedItems = verified.slice(0, 5).map((s) => `- "${s.title}" (${s.domain}, fetched ${s.retrievedAt}): ${(s.excerpt ?? '').slice(0, 300)}`);
    lines.push(...verifiedItems);
  }
  if (discovery.length > 0) {
    lines.push('SEARCH_DISCOVERY — search-result metadata only, NEVER fetched, NOT verified:');
    const discoveryItems = discovery.slice(0, 5).map((s) => `- "${s.title}" (${s.domain}): ${(s.snippet ?? '').slice(0, 200)}`);
    lines.push(...discoveryItems);
  }
  lines.push(
    'Treat VERIFIED_DATA items as sourced observations and SEARCH_DISCOVERY items as unverified leads. ' +
      'Do not invent market sizes, customer counts, prices, or revenue; if the evidence does not answer something, say so.',
  );
  return lines.join('\n').slice(0, 6000);
}

// ---------------------------------------------------------------------------
// Real Research Engine mapping (Phase 5.1)
// ---------------------------------------------------------------------------

import { runResearchSources } from '@/lib/research/engine';

/**
 * Run the Real Research Engine for one objective and map its output into the
 * Research Agent result fields. The engine returns structured discovery and
 * verified evidence; nothing here upgrades discovery into verified data and
 * nothing here invents facts — unavailable research is reported as unavailable.
 */
export async function runRealResearch(input: {
  researchObjective: string;
  opportunityId?: string;
  opportunityTitle?: string;
  marketCategory?: string;
  /** Run engine-internal AI synthesis (the Research Agent does its own). */
  includeAiSynthesis?: boolean;
}): Promise<{ sources: ResearchSourceRef[]; report: ResearchSourceReport }> {
  const query = [input.opportunityTitle, input.researchObjective].filter(Boolean).join(' ').slice(0, 200);
  const result = await runResearchSources({
    objective: input.researchObjective,
    opportunityId: input.opportunityId,
    query,
    maxSources: 5,
    maxFetches: 3,
    includeAiSynthesis: input.includeAiSynthesis ?? true,
  });

  const sources: ResearchSourceRef[] = [
    // Verified evidence first (fetched from origin), then discovery metadata.
    ...result.evidence.map((e) => ({
      url: e.url,
      domain: e.domain,
      title: e.title,
      excerpt: e.excerpt,
      evidenceType: 'VERIFIED_DATA' as const,
      retrievedAt: e.fetchedAt,
      httpStatus: e.httpStatus,
      contentType: e.contentType,
      contentLength: e.contentLength,
      fetchDurationMs: e.fetchDurationMs,
    })),
    ...result.discovery.map((d) => ({
      url: d.url,
      domain: d.domain,
      title: d.title,
      snippet: d.snippet,
      evidenceType: 'SEARCH_DISCOVERY' as const,
      retrievedAt: d.retrievedAt,
    })),
  ];

  return {
    sources,
    report: {
      status: result.status,
      searchProviderId: result.searchProviderId,
      servedFrom: result.servedFrom,
      discoveryCount: result.sourcesDiscovered,
      verifiedCount: result.sourcesSucceeded,
      fetchErrors: result.fetchErrors,
      reasoning: result.reasoning,
      ranAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic mock research output (offline, no key, no network)
// ---------------------------------------------------------------------------

export function buildMockResearchOutput(input: {
  researchObjective: string;
  marketCategory?: string;
}): ResearchAiOutput {
  const subject = input.marketCategory ?? 'this category';
  return {
    summary: `[MOCKED] Deterministic placeholder briefing for: ${input.researchObjective}. Enable AI_PROVIDER=gemini with a valid key for real AI research.`,
    demandSignals: [`[MOCKED] Example demand signal for ${subject}.`],
    audienceHypotheses: ['[MOCKED] Example audience hypothesis: target users have an unmet need in this niche.'],
    painPoints: ['[MOCKED] Example pain point: no dedicated, trustworthy solution currently exists.'],
    competitionObservations: ['[MOCKED] Example competitor observation: adjacent products exist; differentiation is an open question.'],
    monetizationOpportunities: ['[MOCKED] Example monetization hypothesis: multiple revenue streams may be viable.'],
    risks: ['[MOCKED] Example risk: market conditions and competition require human validation.'],
    assumptions: ['[MOCKED] Assumption: target market exists largely as described.', '[MOCKED] Assumption: the user need is real and unmet.'],
    validationQuestions: ['[MOCKED] What is the strongest evidence a user would actually pay?', '[MOCKED] Which competitor already serves this need well?'],
    nextAction: '[MOCKED] Validate the top demand signal with a low-cost experiment before committing resources.',
  };
}

// ---------------------------------------------------------------------------
// Halal safety gate (screening tool, not a religious ruling)
// ---------------------------------------------------------------------------

export type ResearchHalalGateStatus = 'OK' | 'REVIEW' | 'BLOCKED';

export interface ResearchHalalGateResult {
  status: ResearchHalalGateStatus;
  considerations: string[];
}

export function evaluateHalalGate(input: {
  researchObjective: string;
  targetAudience?: string;
  marketCategory?: string;
  halalRequirements?: string[];
  opportunityHalalStatus?: string | null;
}): ResearchHalalGateResult {
  const considerations: string[] = [];
  let status: ResearchHalalGateStatus = 'OK';

  const screen = screenForHalalCompliance(
    input.researchObjective,
    input.targetAudience ?? '',
    input.marketCategory ?? '',
    '',
    (input.halalRequirements ?? []).join(' ')
  );

  if (screen.status === 'NOT_ALLOWED') {
    status = 'BLOCKED';
    considerations.push('Research blocked: the topic screened as NOT_ALLOWED by the halal compliance rules.');
  } else if (screen.status === 'REVIEW_REQUIRED') {
    status = 'REVIEW';
    considerations.push('Human review required: the topic screened as REVIEW_REQUIRED for halal compliance.');
  }

  if (input.opportunityHalalStatus === 'NOT_ALLOWED') {
    status = 'BLOCKED';
    considerations.push('Research blocked: the linked opportunity has NOT_ALLOWED halal status.');
  } else if (input.opportunityHalalStatus === 'REVIEW_REQUIRED') {
    status = 'REVIEW';
    considerations.push('Human review required: the linked opportunity has REVIEW_REQUIRED halal status.');
  }

  if (status === 'OK') {
    considerations.push('Screening: no compliance concerns identified. This is a screening tool, not a religious authority.');
  }

  return { status, considerations };
}