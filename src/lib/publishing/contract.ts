// Phase 5.2 — Publishing integration contracts (provider-neutral boundaries).
//
// IMPLEMENTS CONTRACTS AND ADAPTER BOUNDARIES ONLY. No publishing provider is
// connected in this milestone:
//
//   - No real marketplace/deployment/listing integration exists.
//   - No adapter claims LIVE publication; nothing auto-publishes.
//   - An unconfigured provider reports PUBLISHING_UNAVAILABLE — never a fake
//     success.
//
// The contract mirrors the research provider pattern so a future adapter is
// one class + one registry branch:
//
//   PublishingProvider
//     validate(spec)  → can this spec be served by this provider at all?
//     draft(spec)     → provider-shaped draft artifact (no external call)
//     publish(draft)  → EXTERNAL ACTION (explicit authorization required;
//                       disabled until a real authorized adapter exists)
//     status(ref)     → truthful status of a prior publication
//
// Human control: publish() on the boundary requires an authorized adapter AND
// an explicit human approval token; the boundary itself never publishes.

import type { ProductResult } from '@/lib/agents/types';

// ---------------------------------------------------------------------------
// Publishable product specification (Product Agent output, structured)
// ---------------------------------------------------------------------------

/** The Product Agent's result mapped onto an executable specification. */
export interface PublishableProductSpec {
  productType: string;
  name: string;
  targetAudience: string;
  problem: string;
  valueProposition: string;
  mvpFeatures: { name: string; description: string; priority: string }[];
  buildPhases: { phase: number; name: string; tasks: string[]; expectedOutput: string; risk: string }[];
  monetizationModel: string;
  pricingHypothesis: string;
  distributionChannels: string[];
  risks: string[];
  assumptions: string[];
  evidence: { type: string; content: string }[];
  /** Product Agent provenance carried through — publishing never upgrades it. */
  evidenceProvenance: 'AI_INFERENCE' | 'VERIFIED_DATA' | 'USER_ENTERED' | 'SEARCH_DISCOVERY' | 'MOCKED';
}

/** Map ProductResult (existing agent shape) onto the executable spec. */
export function toPublishableSpec(result: ProductResult): PublishableProductSpec {
  return {
    productType: result.productType,
    name: result.productConcept.productNameHypothesis,
    targetAudience: result.targetCustomer,
    problem: result.problemBeingSolved,
    valueProposition: result.valueProposition,
    mvpFeatures: result.mvpFeatures.map((f) => ({ name: f.name, description: f.description, priority: f.priority })),
    buildPhases: result.buildPhases.map((p) => ({
      phase: p.phase,
      name: p.name,
      tasks: p.tasks,
      expectedOutput: p.expectedOutput,
      risk: p.risk,
    })),
    monetizationModel: String(result.monetizationModel),
    pricingHypothesis: result.pricingHypothesis,
    distributionChannels: result.distributionChannels,
    risks: result.risks,
    assumptions: result.assumptions,
    evidence: result.evidence.map((e) => ({ type: e.type, content: e.content })),
    evidenceProvenance: result.capabilityStatus === 'LIVE' ? 'AI_INFERENCE' : 'MOCKED',
  };
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export type PublishingChannel =
  | 'DIGITAL_PRODUCT'
  | 'APP_STORE'
  | 'WEBSITE_DEPLOYMENT'
  | 'MARKETPLACE_LISTING'
  | 'AFFILIATE_LISTING'
  | 'CONTENT_PUBLISHING';

export type PublishingProviderStatus = 'AVAILABLE' | 'PUBLISHING_UNAVAILABLE' | 'NOT_CONNECTED' | 'PUBLISHING_READY';

export interface PublishingHealth {
  providerId: string | null;
  channel: PublishingChannel;
  status: PublishingProviderStatus;
  hint: string;
}

export interface PublishingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PublishingDraft {
  providerId: string;
  channel: PublishingChannel;
  /** Provider-shaped draft payload (bounded, no secrets). */
  payload: Record<string, unknown>;
  createdAt: string;
  /** Drafts are never live; the boundary cannot create external state. */
  isLive: false;
}

export interface PublishAttempt {
  /**
   * Phase 8 — widened from a constant `false` so a real authorized adapter can
   * report a VERIFIED publication (Rule 2: only after a provider round-trip).
   * Every existing refusal shape is unchanged.
   */
  published: boolean;
  status: 'PUBLISHING_UNAVAILABLE' | 'NOT_AUTHORIZED' | 'PUBLISHED';
  reason: string;
  /** Present only on verified publications (provider-confirmed). */
  publicationId?: string;
  publicationUrl?: string;
}

export interface PublishingProvider {
  readonly id: string;
  readonly channel: PublishingChannel;
  validate(spec: PublishableProductSpec): PublishingValidationResult;
  draft(spec: PublishableProductSpec): PublishingDraft;
  /** NEVER callable without an authorized adapter; boundary refuses. */
  publish(draft: PublishingDraft, humanApprovalToken: string): Promise<PublishAttempt>;
  status(reference: string): Promise<PublishingHealth & { reference: string }>;
}

// ---------------------------------------------------------------------------
// Boundary (the ONLY surface future orchestrators/agents may call)
// ---------------------------------------------------------------------------

export interface PublishingRequest {
  channel: PublishingChannel;
  spec: PublishableProductSpec;
  /** Explicit human approval — required even for future authorized adapters. */
  humanApprovalToken?: string;
}

export interface PublishingResponse {
  status: PublishingProviderStatus | 'NOT_AUTHORIZED';
  providerId: string | null;
  draft: PublishingDraft | null;
  publication: PublishAttempt | null;
  errors: string[];
  warnings: string[];
}

/**
 * Validate → draft → (refuse to) publish. With no adapter registered this
 * returns PUBLISHING_UNAVAILABLE after still performing local validation and
 * producing a DRAFT — useful, honest, and side-effect-free. Publication is
 * structurally impossible until a real authorized adapter is registered AND a
 * human approval token is supplied.
 */
export function requestPublishing(request: PublishingRequest): PublishingResponse {
  const provider = resolvePublishingProvider(request.channel);

  // Local structural validation (provider-independent, deterministic).
  const validation = validateSpecLocally(request.spec);

  if (!provider) {
    return {
      status: 'PUBLISHING_UNAVAILABLE',
      providerId: null,
      draft: null,
      publication: null,
      errors: [
        `No publishing provider is connected for channel ${request.channel}. Nothing was published. `
          + 'Implement a PublishingProvider adapter and register it to enable this channel.',
        ...validation.errors,
      ],
      warnings: validation.warnings,
    };
  }

  const errors = [...validation.errors];
  if (!validation.valid) {
    return {
      status: 'PUBLISHING_UNAVAILABLE',
      providerId: provider.id,
      draft: null,
      publication: null,
      errors: [...errors, 'Specification failed structural validation; no draft or publication was produced.'],
      warnings: validation.warnings,
    };
  }

  const draft = provider.draft(request.spec);

  // Publication requires BOTH an authorized adapter and explicit human approval.
  if (!request.humanApprovalToken || request.humanApprovalToken.trim().length === 0) {
    return {
      status: 'NOT_AUTHORIZED',
      providerId: provider.id,
      draft,
      publication: {
        published: false,
        status: 'NOT_AUTHORIZED',
        reason: 'Publication requires explicit human approval. The draft is ready; nothing is live.',
      },
      errors,
      warnings: validation.warnings,
    };
  }

  // A boundary without a real adapter still refuses: this is synchronous and
  // cannot reach an external system. Future authorized adapters will implement
  // their own publish() and this branch will delegate to them.
  return {
    status: 'NOT_AUTHORIZED',
    providerId: provider.id,
    draft,
    publication: {
      published: false,
      status: 'NOT_AUTHORIZED',
      reason: 'No authorized publishing adapter is registered for this channel; publication is structurally unavailable.',
    },
    errors,
    warnings: validation.warnings,
  };
}

/**
 * Resolve a registered provider. Phase 8: the Polar adapter serves the
 * DIGITAL_PRODUCT channel when POLAR_ACCESS_TOKEN is configured; without it
 * the honest result is still `null` (the boundary reports
 * PUBLISHING_UNAVAILABLE, AUTH_REQUIRED is surfaced by the capability center).
 */
export function resolvePublishingProvider(channel: PublishingChannel): PublishingProvider | null {
  if (channel === 'DIGITAL_PRODUCT') {
    // Lazy env probe avoids importing the adapter (and its network surface)
    // when unconfigured; the adapter itself stays server-only.
    const token = process.env.POLAR_ACCESS_TOKEN;
    if (typeof token === 'string' && token.trim().length >= 10) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load avoids a module cycle; same pattern as job-runner
      const { PolarPublishingAdapter } = require('./../integrations/polar-publishing') as {
        PolarPublishingAdapter: new () => PublishingProvider;
      };
      return new PolarPublishingAdapter();
    }
  }
  void channel;
  return null;
}

/** Describe publishing readiness truthfully for dashboards. */
export function describePublishingStatus(): { status: PublishingProviderStatus; note: string; channels: PublishingChannel[] } {
  // Phase 8 (Rule 2/5): status reflects configuration only — a configured
  // adapter is reported as AUTHORIZED-READY, never as having published
  // anything. LIVE publication claims only ever come from a verified provider
  // round-trip on a specific publication (see the Polar adapter).
  const configured =
    typeof process.env.POLAR_ACCESS_TOKEN === 'string' && process.env.POLAR_ACCESS_TOKEN.trim().length >= 10;
  return {
    status: configured ? 'PUBLISHING_READY' : 'PUBLISHING_UNAVAILABLE',
    note: configured
      ? 'Polar adapter is configured server-side for DIGITAL_PRODUCT. Each publication still requires an '
        + 'explicit human approval token, and PUBLISHED is claimed only after a verified provider round-trip '
        + '(create + confirm). Configuration alone is never reported as live.'
      : 'Publishing contracts and adapter boundaries are implemented. No publishing provider is connected, '
        + 'so every channel reports PUBLISHING_UNAVAILABLE. No automatic publication exists; '
        + 'adapters additionally require explicit human approval per publication.',
    channels: ['DIGITAL_PRODUCT', 'APP_STORE', 'WEBSITE_DEPLOYMENT', 'MARKETPLACE_LISTING', 'AFFILIATE_LISTING', 'CONTENT_PUBLISHING'],
  };
}

// ---------------------------------------------------------------------------
// Structural validation (deterministic, no external calls)
// ---------------------------------------------------------------------------

export function validateSpecLocally(spec: PublishableProductSpec): PublishingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec.name || spec.name.trim().length === 0) errors.push('Product name is required.');
  if (!spec.problem || spec.problem.trim().length === 0) errors.push('Problem statement is required.');
  if (!spec.valueProposition || spec.valueProposition.trim().length === 0) errors.push('Value proposition is required.');
  if (!spec.monetizationModel || spec.monetizationModel.trim().length === 0) errors.push('Monetization model is required.');
  if (spec.mvpFeatures.length === 0) errors.push('At least one MVP feature is required.');
  if (spec.buildPhases.length === 0) warnings.push('No build phases specified; the spec is not execution-ready.');
  if (spec.evidenceProvenance === 'MOCKED') {
    warnings.push('Specification derives from MOCKED agent output; treat as a template, not a validated plan.');
  }
  if (!spec.evidence.some((e) => e.type === 'VERIFIED_DATA')) {
    warnings.push('No VERIFIED_DATA evidence attached to the specification.');
  }

  return { valid: errors.length === 0, errors: errors.slice(0, 10), warnings: warnings.slice(0, 10) };
}
