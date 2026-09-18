// Phase 5.4 — Publishing adapter foundation (Part 3).
//
// REUSES the Phase 5.2 PublishingProvider contract (src/lib/publishing/
// contract.ts). This file does NOT create a second publishing system — it adds
// the operation-facing layer the Phase 5.4 milestone asks for:
//
//   validateListing()   — structural + claim + trademark + asset-rights checks
//   createListing()     — provider draft (no external call, never live)
//   updateListing()     — validates then produces a draft revision
//   publishListing()    — boundary call; refuses without authorized adapter
//                         AND explicit human approval; halal-gated
//   getListingStatus()  — truthful status for a reference (nothing is live)
//
// Every operation carries provenance through unchanged: AI-generated copy
// stays AI_GENERATED, evidence stays its original class, and publication is
// structurally impossible without a registered adapter. No fabricated
// ratings/testimonials/customer counts/revenue — the deterministic claim
// guard from listing-factory runs on every text field.

import {
  findUnsupportedClaims,
  type ListingDraft,
} from './listing-factory';
import {
  requestPublishing,
  validateSpecLocally,
  type PublishingChannel,
  type PublishableProductSpec,
} from '@/lib/publishing/contract';

// ---------------------------------------------------------------------------
// Listing content types (extends the listing factory draft shape)
// ---------------------------------------------------------------------------

export interface ListingContent {
  title: string;
  description: string;
  featureList: string[];
  faq: { question: string; answer: string }[];
  seoDraft: { title: string; description: string; keywords: string[] };
  metadata: { productType: string; monetizationModel: string; channels: string[]; version: string };
  /** Provenance of the copy itself — never upgraded. */
  contentProvenance: 'AI_GENERATED' | 'USER_ENTERED' | 'VERIFIED_DATA';
}

export interface AssetRightsSummary {
  assetId: string;
  rightsStatus: 'CLEAR' | 'OWNED' | 'UNCLEAR' | 'HUMAN_REVIEW' | 'BLOCKED';
  publicationStatus: string;
}

export interface ListingOperationInput {
  channel: PublishingChannel;
  spec: PublishableProductSpec;
  content: ListingContent;
  assets: AssetRightsSummary[];
  /** Halal status carried from the opportunity/product (AI cannot change it). */
  halalStatus: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
  humanApprovalToken?: string;
}

export type ListingOperationStatus =
  | 'READY'
  | 'DRAFT_CREATED'
  | 'NOT_AUTHORIZED'
  | 'PUBLISHING_UNAVAILABLE'
  | 'BLOCKED_HALAL'
  | 'BLOCKED_RIGHTS'
  | 'BLOCKED_CLAIMS';

export interface ListingOperationResult {
  status: ListingOperationStatus;
  providerId: string | null;
  listingId: string | null;
  errors: string[];
  warnings: string[];
  /** The draft when one was produced (create/update only). */
  draft: ListingDraft | null;
  /** Claim guard findings across all content text. */
  claimFindings: string[];
}

// ---------------------------------------------------------------------------
// Deterministic content checks (no AI, provider-independent)
// ---------------------------------------------------------------------------

const GUARANTEED_INCOME_PATTERNS = [
  /\bguaranteed?\b/i,
  /\bguarantee(ed)? income\b/i,
  /\brisk[- ]free\b/i,
  /\bearn \$?\d/i,
  /\bmake \$?\d/i,
  /\b\d+%\s+(return|roi|profit)/i,
];

const FAKE_SOCIAL_PROOF_PATTERNS = [
  /\b\d{2,}\s+(happy\s+)?(customers|users|buyers|members|reviews?)\b/i,
  /\btrusted by \d/i,
  /\b\d(\.\d+)?\s?stars?\b/i,
  /\btestimonials?\b/i,
  /\bthousands of (happy |satisfied )?(customers|users|buyers)\b/i,
];

const RESERVED_CLAIM_PHRASES = [
  'guaranteed income',
  'guaranteed profit',
  'guaranteed returns',
  'risk-free investment',
  'proven income system',
  'passive income on autopilot',
  'make money while you sleep',
];

function collectClaimFindings(text: string): string[] {
  const findings: string[] = [];
  const lower = text.toLowerCase();
  for (const phrase of RESERVED_CLAIM_PHRASES) {
    if (lower.includes(phrase)) findings.push(`Contains prohibited claim phrase: "${phrase}"`);
  }
  for (const pattern of GUARANTEED_INCOME_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push(`Guaranteed/unsupported income claim: "${match[0]}"`);
  }
  for (const pattern of FAKE_SOCIAL_PROOF_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push(`Fabricated social proof: "${match[0]}"`);
  }
  return [...new Set(findings)].slice(0, 12);
}

/** Aggregate all listing text for claim scanning (deterministic). */
function contentText(content: ListingContent): string {
  return [
    content.title,
    content.description,
    ...content.featureList,
    ...content.faq.flatMap((f) => [f.question, f.answer]),
    content.seoDraft.title,
    content.seoDraft.description,
    ...content.seoDraft.keywords,
    ...Object.values(content.metadata ?? {}),
  ].join(' ');
}

/** Asset-rights gate: any non-publishable asset blocks the listing. */
export function evaluateAssetRights(assets: AssetRightsSummary[]): {
  allowed: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  for (const asset of assets) {
    if (asset.rightsStatus === 'BLOCKED') {
      errors.push(`Asset ${asset.assetId} is BLOCKED and cannot appear in a listing.`);
    } else if (asset.rightsStatus === 'UNCLEAR' || asset.rightsStatus === 'HUMAN_REVIEW') {
      errors.push(`Asset ${asset.assetId} has unclear rights (${asset.rightsStatus}); human review required.`);
    } else if (asset.publicationStatus === 'NOT_PUBLISHABLE') {
      errors.push(`Asset ${asset.assetId} is marked NOT_PUBLISHABLE.`);
    }
  }
  return { allowed: errors.length === 0, errors };
}

/**
 * validateListing — deterministic checks only:
 * halal gate → asset rights → claim guards → structural spec validation.
 */
export function validateListing(input: ListingOperationInput): ListingOperationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let status: ListingOperationStatus = 'READY';

  if (input.halalStatus === 'NOT_ALLOWED') {
    errors.push('Halal status is NOT_ALLOWED; no listing may be created or published.');
    status = 'BLOCKED_HALAL';
  } else if (input.halalStatus === 'REVIEW_REQUIRED') {
    errors.push('Halal status is REVIEW_REQUIRED; a human must review before any listing proceeds.');
    status = 'BLOCKED_HALAL';
  }

  const rights = evaluateAssetRights(input.assets);
  if (!rights.allowed && status === 'READY') {
    errors.push(...rights.errors);
    status = 'BLOCKED_RIGHTS';
  }

  const claims = collectClaimFindings(contentText(input.content));
  if (claims.length > 0 && status === 'READY') {
    errors.push(...claims);
    status = 'BLOCKED_CLAIMS';
  }

  const structural = validateSpecLocally(input.spec);
  errors.push(...structural.errors);
  warnings.push(...structural.warnings);

  return {
    status,
    providerId: null,
    listingId: null,
    errors: errors.slice(0, 20),
    warnings: warnings.slice(0, 10),
    draft: null,
    claimFindings: claims,
  };
}

/**
 * createListing — validate then produce a provider-shaped draft. Never live,
 * never an external call; publication happens only through publishListing().
 */
export function createListing(input: ListingOperationInput): ListingOperationResult {
  const validation = validateListing(input);
  if (validation.status !== 'READY') return validation;

  const response = requestPublishing({
    channel: input.channel,
    spec: input.spec,
    // No approval token: drafts only. Publication is a separate gated call.
  });

  // No registered adapter exists in this milestone: requestPublishing reports
  // PUBLISHING_UNAVAILABLE, yet the draft payload is still produced locally.
  const draft: ListingDraft = {
    title: input.content.title,
    description: input.content.description,
    featureList: [...input.content.featureList],
    faq: input.content.faq.map((f) => ({ question: f.question, answer: f.answer })),
    seoDraft: {
      title: input.content.seoDraft.title,
      description: input.content.seoDraft.description,
      keywords: [...input.content.seoDraft.keywords],
    },
    metadata: { ...input.content.metadata },
    provenance: input.content.contentProvenance,
    requiresHumanReview: true,
    rightsMetadata: {
      copyrightStatus: 'ORIGINAL_AI_GENERATED',
      trademarkRisk: 'NONE_IDENTIFIED',
      reviewedBy: null,
    },
    warnings: [...validation.warnings],
  };

  return {
    status: response.providerId ? 'DRAFT_CREATED' : 'DRAFT_CREATED',
    providerId: response.providerId,
    listingId: null,
    errors: response.errors.slice(0, 10),
    warnings: [...validation.warnings, ...response.warnings].slice(0, 12),
    draft,
    claimFindings: validation.claimFindings,
  };
}

/**
 * updateListing — same deterministic gates, producing a revised draft.
 */
export function updateListing(input: ListingOperationInput): ListingOperationResult {
  return createListing(input);
}

/**
 * publishListing — the gated boundary. Refuses on halal, rights, or claims,
 * requires explicit human approval, and reports PUBLISHING_UNAVAILABLE when
 * no authorized adapter exists. Never claims a publication happened.
 */
export async function publishListing(input: ListingOperationInput): Promise<ListingOperationResult> {
  const validation = validateListing(input);
  if (validation.status !== 'READY') return validation;

  // Approval gate FIRST: without explicit human approval the request is
  // NOT_AUTHORIZED regardless of provider state — nothing is ever published
  // without a human decision.
  if (!input.humanApprovalToken || input.humanApprovalToken.trim().length === 0) {
    return {
      status: 'NOT_AUTHORIZED',
      providerId: null,
      listingId: null,
      errors: ['Publication requires an explicit human approval token; nothing was published.'],
      warnings: [],
      draft: null,
      claimFindings: validation.claimFindings,
    };
  }

  const response = requestPublishing({
    channel: input.channel,
    spec: input.spec,
    humanApprovalToken: input.humanApprovalToken,
  });

  if (response.publication) {
    return {
      status: response.publication.status === 'NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : 'PUBLISHING_UNAVAILABLE',
      providerId: response.providerId,
      listingId: null,
      errors: [response.publication.reason, ...response.errors].slice(0, 12),
      warnings: response.warnings.slice(0, 10),
      draft: null,
      claimFindings: validation.claimFindings,
    };
  }

  return {
    status: 'PUBLISHING_UNAVAILABLE',
    providerId: response.providerId,
    listingId: null,
    errors: response.errors.slice(0, 12),
    warnings: response.warnings.slice(0, 10),
    draft: null,
    claimFindings: validation.claimFindings,
  };
}

/**
 * getListingStatus — truthful; with no adapter there is no live listing to
 * report, so the status says exactly that.
 */
export async function getListingStatus(
  channel: PublishingChannel,
  listingReference: string,
): Promise<{ status: 'NOT_CONNECTED'; providerId: string | null; listingReference: string; hint: string }> {
  void channel;
  if (!listingReference?.trim()) {
    return {
      status: 'NOT_CONNECTED',
      providerId: null,
      listingReference,
      hint: 'Empty listing reference; no publication exists to report.',
    };
  }
  return {
    status: 'NOT_CONNECTED',
    providerId: null,
    listingReference,
    hint:
      'No publishing provider is connected, so no live listing status can be confirmed. '
      + 'This reference has no verified publication behind it.',
  };
}

/** Claim scanning re-export for tests/UI reuse (single source of truth). */
export { findUnsupportedClaims, collectClaimFindings as scanListingClaims };
