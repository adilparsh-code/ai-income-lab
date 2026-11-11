// HIGH-1 — Deterministic example opportunity + handoff envelope for the
// first intelligence vertical slice.
//
// This is the single source of truth for the example used in the slice tests.
// It is a SPECIFICATION, not a claim of validated market demand, a published
// product, or a revenue commitment. The example is deliberately a small,
// halal-clean, deterministic niche practical guide packet so the slice can
// trace one approved opportunity end-to-end through handoff → research →
// validation → product concept → human review.

export const EXAMPLE_OPPORTUNITY_ID = 'opp-slice-example-001';
export const EXAMPLE_CONTRACT_ID = 'aiagent.income-lab.opportunity-handoff';
export const EXAMPLE_IDEMPOTENCY_KEY = 'slice-example-approved-opportunity:v1';
export const EXAMPLE_CORRELATION_ID = 'slice-example-approved-opportunity';
export const OWNER_ID_FOR_SENDER = 'owner-slice-example';

// The sender identity is NOT part of the delivery envelope contract. It is
// supplied by the authenticated transport (the `receiveHandoff` options), never
// asserted by the untrusted envelope body, so it is exported separately here.
export const EXAMPLE_SENDER_IDENTITY = 'aiagent-handoff-sender';

export const EXAMPLE_OPPORTUNITY: {
  opportunityId: string;
  title: string;
  category: string;
  targetAudience: string;
  customerProblem: string;
  monetizationMethod: string;
  businessModel: string;
  halalStatus: string;
  overallScore: number;
} = {
  opportunityId: EXAMPLE_OPPORTUNITY_ID,
  title: 'Practical Notion workspace setup guide for small solo operators',
  category: 'DIGITAL_PRODUCT',
  targetAudience: 'Solo operators and tiny teams who want one clean workspace instead of six scattered tools',
  customerProblem:
    'Small operators end up juggling notes, tasks, client details and lightweight processes across several tools, and they waste time re-finding what they already captured.',
  monetizationMethod: 'ONE_TIME_PURCHASE',
  businessModel: 'DIRECT_SALES',
  halalStatus: 'HALAL',
  overallScore: 78,
};

export const EXAMPLE_ENVELOPE: {
  contractVersion: string;
  contractId: string;
  idempotencyKey: string;
  correlationId: string;
  eventType: string;
  title: string;
  description: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
  assertedEligibility: string;
  payload: Record<string, unknown>;
} = {
  contractVersion: '1.0',
  contractId: EXAMPLE_CONTRACT_ID,
  idempotencyKey: EXAMPLE_IDEMPOTENCY_KEY,
  correlationId: EXAMPLE_CORRELATION_ID,
  eventType: 'OPPORTUNITY_PROPOSED',
  title: 'Practical Notion workspace setup guide for small solo operators',
  description:
    'A short, practical guide that helps small solo operators set up one clean Notion workspace for notes, tasks, clients and lightweight processes, instead of scattering the same information across multiple tools.',
  category: 'DIGITAL_PRODUCT',
  businessModel: 'DIRECT_SALES',
  monetizationMethod: 'ONE_TIME_PURCHASE',
  assertedEligibility: 'ALLOWED',
  payload: {
    sourceOpportunityId: EXAMPLE_OPPORTUNITY_ID,
    suggestedFormat: 'PDF guide + Notion template',
    suggestedPriceUsd: 29,
  },
};

export type ExampleEnvelope = typeof EXAMPLE_ENVELOPE;
export type ExampleOpportunity = typeof EXAMPLE_OPPORTUNITY;
