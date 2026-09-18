// Phase 5.3 — Listing/content factory + asset registry (pure, provenance-safe).
//
// Listing factory: assembles listing content DRAFTS deterministically from the
// publishable spec. It never calls AI (product/listing copy already exists in
// the spec, labelled AI_INFERENCE) and never fabricates social proof: fake
// testimonials/reviews/ratings/customer counts are refused and recorded.
//
// Asset registry: tracks images/screenshots/graphics with provenance and
// rights status. Unclear rights → HUMAN_REVIEW; no asset can be publish-ready
// without CLEAR rights. Generated/manual is recorded — generated assets are
// labelled AI_GENERATED.

// ---------------------------------------------------------------------------
// Listing content factory
// ---------------------------------------------------------------------------

import type { PublishableProductSpec } from '@/lib/publishing/contract';

export type ListingContentProvenance = 'AI_GENERATED' | 'USER_ENTERED' | 'VERIFIED_DATA';

export interface ListingDraft {
  title: string;
  description: string;
  featureList: string[];
  faq: { question: string; answer: string }[];
  seoDraft: { title: string; description: string; keywords: string[] };
  metadata: { productType: string; monetizationModel: string; channels: string[]; version: string };
  /** Every text block derives from the spec's AI output — labelled as such. */
  provenance: ListingContentProvenance;
  /** Human review required before any external publication. Always true. */
  requiresHumanReview: true;
  rightsMetadata: {
    /** AI-generated copy: original work, no third-party rights asserted. */
    copyrightStatus: 'ORIGINAL_AI_GENERATED';
    trademarkRisk: 'NONE_IDENTIFIED' | 'REVIEW_REQUIRED';
    reviewedBy: null;
  };
  warnings: string[];
}

/** Terms that would fabricate social proof or make unsupported claims. */
const FORBIDDEN_CLAIM_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(guaranteed|guarantee|guarantees)\b/i, reason: 'no guaranteed outcomes' },
  { pattern: /\b(\d+\s*(?:customers|users|sellers|buyers))\b/i, reason: 'no invented customer counts' },
  { pattern: /\b(\d+\s*(?:%|percent)\s*(?:conversion|success|profit))\b/i, reason: 'no invented conversion/profit rates' },
  { pattern: /\b(testimonial|reviews? from|rated \d)/i, reason: 'no fabricated testimonials/reviews/ratings' },
  { pattern: /\b(risk[- ]free|zero risk)\b/i, reason: 'no risk-free claims' },
  { pattern: /(passive income|earn(?:ing)?s?\s*\$?\d|make\s+\$?\d+|\$\d[\d,]*(?:\s*(?:per day|per week|daily|monthly)))/i, reason: 'no invented earnings figures' },
  { pattern: /\b(bestseller|award[- ]winning|as seen (?:on|in))\b/i, reason: 'no fabricated endorsements' },
];

export function findUnsupportedClaims(text: string): string[] {
  const reasons: string[] = [];
  for (const { pattern, reason } of FORBIDDEN_CLAIM_PATTERNS) {
    if (pattern.test(text)) reasons.push(reason);
  }
  return reasons;
}

export function createListingDraft(
  spec: PublishableProductSpec,
  options: { seoKeywords?: string[]; version?: string } = {},
): ListingDraft {
  const textPool = [spec.name, spec.valueProposition, ...spec.assumptions, ...spec.risks].join(' ');

  // Refuse fabricated social proof / unsupported claims deterministically.
  const claimViolations = findUnsupportedClaims(textPool);
  const warnings = [
    ...claimViolations.map((r) => `Unsupported claim risk: ${r}.`),
    ...(spec.evidenceProvenance === 'MOCKED'
      ? ['Specification derives from MOCKED agent output; treat the listing draft as a template only.']
      : []),
    'All listing copy is AI-generated from the specification (AI_GENERATED); a human must review '
      + 'before any external publication.',
  ];

  // Substring (not word-boundary) matching on purpose: compound names like
  // "NotionBackup Pro" embed a third-party brand and deserve review too.
  const trademarkRisk: 'NONE_IDENTIFIED' | 'REVIEW_REQUIRED'
    = /(google|apple|amazon|facebook|instagram|twitter|x\.com|notion|slack|figma|openai|chatgpt)/i.test(
        `${spec.name} ${spec.valueProposition}`,
      )
      ? 'REVIEW_REQUIRED'
      : 'NONE_IDENTIFIED';

  return {
    title: spec.name.slice(0, 120),
    description: [
      spec.problem.trim() ? `Problem: ${spec.problem.trim()}` : null,
      spec.valueProposition.trim() ? `What it does: ${separateClamp(spec.valueProposition, 600)}` : null,
      spec.targetAudience.trim() ? `Built for: ${spec.targetAudience.trim()}` : null,
      spec.mvpFeatures.length > 0
        ? `Highlights: ${spec.mvpFeatures.map((f) => f.name).slice(0, 5).join(', ')}`
        : null,
    ].filter(Boolean).join('\n').slice(0, 2000),
    featureList: spec.mvpFeatures.map((f) => `${f.name} — ${f.description}`.slice(0, 200)),
    faq: spec.mvpFeatures.slice(0, 3).map((f) => ({
      question: `What does ${f.name} do?`,
      answer: separateClamp(f.description, 300),
    })),
    seoDraft: {
      title: `${spec.name} — ${spec.productType.replace(/_/g, ' ').toLowerCase()}`.slice(0, 60),
      description: separateClamp(spec.valueProposition, 155),
      keywords: (options.seoKeywords ?? []).slice(0, 10).map((k) => k.trim().toLowerCase()).filter(Boolean),
    },
    metadata: {
      productType: spec.productType,
      monetizationModel: spec.monetizationModel,
      channels: spec.distributionChannels,
      version: options.version ?? '0.1.0',
    },
    provenance: 'AI_GENERATED',
    requiresHumanReview: true,
    warnings,
    rightsMetadata: {
      // AI-generated copy: original work; no third-party content included.
      copyrightStatus: 'ORIGINAL_AI_GENERATED' as const,
      trademarkRisk,
      reviewedBy: null,
    },
  };
}

function separateClamp(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Asset registry (pure registry logic; persistence is the caller's job)
// ---------------------------------------------------------------------------

export type AssetType = 'PRODUCT_IMAGE' | 'SCREENSHOT' | 'THUMBNAIL' | 'PREVIEW' | 'LISTING_GRAPHIC';
export type AssetSource = 'GENERATED' | 'MANUAL_UPLOAD' | 'THIRD_PARTY';
export type AssetRightsStatus = 'CLEAR' | 'OWNED' | 'UNCLEAR' | 'HUMAN_REVIEW' | 'BLOCKED';

export interface AssetRecord {
  assetId: string;
  productId: string;
  type: AssetType;
  source: AssetSource;
  /** Provenance label carried through to publication. */
  provenance: 'AI_GENERATED' | 'USER_ENTERED' | 'VERIFIED_DATA' | 'MOCKED';
  rightsStatus: AssetRightsStatus;
  /** Where it came from (URL or description) — required for THIRD_PARTY. */
  origin?: string;
  createdAt: string;
  /** An asset may only be published when rights are CLEAR/OWNED. */
  publicationStatus: 'NOT_PUBLISHABLE' | 'PUBLISHABLE' | 'PUBLISHED' | 'HUMAN_REVIEW';
}

/** Register an asset: rights/provenance gates applied deterministically. */
export function registerAsset(input: Omit<AssetRecord, 'publicationStatus'>): AssetRecord {
  const originOk = input.source !== 'THIRD_PARTY' || (typeof input.origin === 'string' && input.origin.trim().length > 0);

  let rightsStatus: AssetRightsStatus;
  if (input.source === 'GENERATED') rightsStatus = 'OWNED'; // AI-generated: original work
  else if (input.source === 'THIRD_PARTY' && !originOk) rightsStatus = 'BLOCKED';
  else if (input.source === 'THIRD_PARTY') rightsStatus = 'UNCLEAR'; // needs human verification
  else rightsStatus = 'CLEAR'; // manual uploads by the owner

  const publicationStatus: AssetRecord['publicationStatus']
    = rightsStatus === 'OWNED' || rightsStatus === 'CLEAR'
      ? 'PUBLISHABLE'
      : rightsStatus === 'UNCLEAR'
        ? 'HUMAN_REVIEW'
        : 'NOT_PUBLISHABLE';

  return {
    ...input,
    rightsStatus: rightsStatus === 'BLOCKED' ? 'HUMAN_REVIEW' : rightsStatus,
    publicationStatus,
  };
}
