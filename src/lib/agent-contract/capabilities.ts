// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — capability catalog + write authority
// ============================================================================
// The capability model for external AI agents. Every capability is a named,
// classified entry in this catalog; NOTHING outside it is reachable through
// the agent API. Authority is server-derived: the presented credential maps
// to an explicit allow-list of capabilities (grant), and each capability
// carries its write authority class.
//
// Invariants:
// - No external capability maps to raw DB access, arbitrary job types, or
//   administrative actions. The Job Runner (with its own halal/budget/review
//   gates) remains the only executor for every BOUNDED_WRITE below.
// - HUMAN_APPROVAL capabilities never execute on an agent request. They
//   create a HumanReview row and return HUMAN_APPROVAL_REQUIRED.
// - The classification is enforced in code (processor.ts); an agent can never
//   upgrade its own authority by changing what it sends.
// ============================================================================

import { isAgentAction, type AgentAction } from './contract';

/** Write authority classes. Enforced in the processor, not by convention. */
export const WRITE_AUTHORITIES = ['READ', 'SAFE_WRITE', 'BOUNDED_WRITE', 'HUMAN_APPROVAL'] as const;
export type WriteAuthority = (typeof WRITE_AUTHORITIES)[number];

export interface AgentCapability {
  /** Stable capability id (equal to the wire `action` value). */
  id: AgentAction;
  authority: WriteAuthority;
  /** Server-side job type dispatched through the EXISTING Job Runner. */
  jobType: string | null;
  /** Fixed payload the server builds from the (validated) agent payload. */
  jobPayloadShape: Record<string, string>;
  /** True when the action MUST pass through the halal gate before dispatch. */
  halalScreened: boolean;
  /** HumanReview category used when authority is HUMAN_APPROVAL. */
  reviewCategory: 'SAFETY_REVIEW' | 'PUBLICATION' | 'PAYMENT_CONFIG' | 'SECURITY_CHANGE' | 'IRREVERSIBLE' | null;
  description: string;
}

/**
 * The complete v1 catalog. Deliberately small: this is the minimum read +
 * bounded-write surface a future agent needs, and nothing more.
 */
export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  {
    id: 'READ_OPPORTUNITY',
    authority: 'READ',
    jobType: null,
    jobPayloadShape: {},
    halalScreened: false,
    reviewCategory: null,
    description: 'Read the bounded public projection of one opportunity (no raw records, no PII).',
  },
  {
    id: 'READ_ANALYTICS',
    authority: 'READ',
    jobType: null,
    jobPayloadShape: {},
    halalScreened: false,
    reviewCategory: null,
    description: 'Read the bounded recorded analytics summary for one opportunity.',
  },
  {
    id: 'READ_REVENUE',
    authority: 'READ',
    jobType: null,
    jobPayloadShape: {},
    halalScreened: false,
    reviewCategory: null,
    description: 'Read the bounded recorded revenue summary for one opportunity.',
  },
  {
    id: 'WRITE_RESEARCH_EVIDENCE',
    authority: 'SAFE_WRITE',
    jobType: 'RESEARCH',
    jobPayloadShape: {
      researchObjective: 'from payload (1..2000 chars)',
      marketCategory: 'from payload, optional',
      targetAudience: 'from payload, optional',
      source: 'AGENT_V1 (fixed)',
    },
    halalScreened: true,
    reviewCategory: null,
    description: 'Submit a research objective; dispatched as a RESEARCH job through the Job Runner.',
  },
  {
    id: 'RUN_VALIDATION',
    authority: 'SAFE_WRITE',
    jobType: 'VALIDATION',
    jobPayloadShape: {
      validationObjective: 'from payload (1..2000 chars)',
      opportunityId: 'from payload, optional',
      source: 'AGENT_V1 (fixed)',
    },
    halalScreened: true,
    reviewCategory: null,
    description: 'Request a validation run on an existing opportunity; dispatched as a VALIDATION job.',
  },
  {
    id: 'CREATE_EXPERIMENT',
    authority: 'BOUNDED_WRITE',
    jobType: 'OPPORTUNITY_PIPELINE',
    jobPayloadShape: {
      objective: 'from payload (1..2000 chars)',
      opportunityId: 'from payload, optional',
      source: 'AGENT_V1 (fixed)',
    },
    halalScreened: true,
    reviewCategory: null,
    description: 'Request a bounded experiment through the pipeline boundary; Job Runner halal/budget gates apply.',
  },
  {
    id: 'CREATE_PRODUCT_PLAN',
    authority: 'BOUNDED_WRITE',
    jobType: 'OPPORTUNITY_PIPELINE',
    jobPayloadShape: {
      objective: 'from payload (1..2000 chars)',
      opportunityId: 'from payload, optional',
      source: 'AGENT_V1 (fixed)',
    },
    halalScreened: true,
    reviewCategory: null,
    description: 'Request a bounded product-planning pipeline run; Job Runner gates apply.',
  },
  {
    id: 'REQUEST_PUBLISH',
    authority: 'HUMAN_APPROVAL',
    jobType: null,
    jobPayloadShape: { productId: 'from payload (1..128 chars)' },
    halalScreened: false,
    reviewCategory: 'PUBLICATION',
    description: 'Request publication of a product. NEVER executes — creates a HumanReview row.',
  },
  {
    id: 'REQUEST_CONFIG_CHANGE',
    authority: 'HUMAN_APPROVAL',
    jobType: null,
    jobPayloadShape: { changeSummary: 'from payload (1..500 chars)' },
    halalScreened: false,
    reviewCategory: 'SECURITY_CHANGE',
    description: 'Request a configuration change. NEVER executes — creates a HumanReview row.',
  },
] as const;

export const AGENT_CAPABILITY_IDS = AGENT_CAPABILITIES.map((c) => c.id);

export function getCapability(action: string): AgentCapability | null {
  return AGENT_CAPABILITIES.find((c) => c.id === action) ?? null;
}

// ---------------------------------------------------------------------------
// Grants — the per-credential capability allow-list (server-side env config)
// ---------------------------------------------------------------------------

/**
 * Grant format for AGENT_<NAME>_CAPABILITIES: comma-separated capability ids
 * or `*` for every catalog capability. Anything else is NOT_CONFIGURED and
 * fails closed. Example:
 *   AGENT_RESEARCH_LAB_CAPABILITIES="READ_OPPORTUNITY,WRITE_RESEARCH_EVIDENCE"
 */
export const GRANT_ALL_WILDCARD = '*';

export function parseGrant(raw: string | undefined | null): AgentAction[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  if (trimmed === GRANT_ALL_WILDCARD) return [...AGENT_CAPABILITY_IDS];
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgentAction => isAgentAction(s));
}

export interface AuthorizationVerdict {
  allowed: boolean;
  reason: string;
  /** True when the capability exists but the grant does not include it. */
  capabilityExists: boolean;
}

/** Pure capability check: is `action` in `granted`? (No DB, no env.) */
export function authorizeCapability(action: AgentAction, granted: readonly AgentAction[]): AuthorizationVerdict {
  if (!getCapability(action)) {
    return { allowed: false, reason: 'Unknown capability.', capabilityExists: false };
  }
  if (granted.includes(action)) {
    return { allowed: true, reason: 'Capability granted.', capabilityExists: true };
  }
  return {
    allowed: false,
    reason: 'Capability not granted to this agent credential. Request access via the operator.',
    capabilityExists: true,
  };
}

/** Minimum required grant keys — used by NOT_CONFIGURED health derivation. */
export function grantEnvKeyForLabel(label: string): string {
  const suffix = label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `AGENT_${suffix}_CAPABILITIES`;
}
