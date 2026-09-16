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
import type { AgentStatus, EvidenceType, ResearchFinding, ResearchResult, ResearchSignal } from '@/lib/agents/types';
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
    capabilityStatus: input.capabilityStatus,
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