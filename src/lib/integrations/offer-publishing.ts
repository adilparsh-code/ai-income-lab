// ============================================================================
// OFFER → POLAR PUBLICATION (human-gated bridge on the EXISTING adapter).
// ============================================================================
// Completes the missing link of the Polar first-sale chain:
//
//   ACTIVE + HALAL + PRICED OFFER → human-approved Polar product → checkout
//
// Reuses (never duplicates):
//   - PolarPublishingAdapter          (src/lib/integrations/polar-publishing.ts)
//       — validate/draft/publish with its own human-token + config re-checks,
//         POST + GET provider round-trip before "PUBLISHED" is ever claimed;
//   - publicListingVerdict            (src/lib/storefront/eligibility.ts)
//       — the same fail-closed gate the storefront uses: ACTIVE, HALAL,
//         price > 0, plus display-time halal re-screening;
//   - auditSecurityEvent/credentialFingerprint (src/lib/security/guard.ts)
//       — every attempt audited with a token FINGERPRINT, never the token.
//
// Deliberately NOT done here: no schema change (the Polar product id/URL is
// persisted into the EXISTING Product.platform + Product.productUrl fields,
// which the storefront already renders as its external "Buy" link), no
// autonomous publishing (an explicit human approval token from an
// admin-authenticated route is required), and no second revenue/webhook path.
// ============================================================================

import { PolarPublishingAdapter } from './polar-publishing';
import type { PublishableProductSpec, PublishAttempt, PublishingDraft } from '@/lib/publishing/contract';
import { publicListingVerdict } from '@/lib/storefront/eligibility';
import { getOfferById } from '@/lib/commercial/offer-service';
import { auditSecurityEvent, credentialFingerprint } from '@/lib/security/guard';
import { db } from '@/lib/db';

const POLAR_URL_PREFIX = 'https://polar.sh/';
const MAX_APPROVAL_TOKEN_CHARS = 512;

// ---------------------------------------------------------------------------
// Pure gates — every condition required BEFORE a human approval can publish.
// Fail-closed: any missing condition refuses publication outright.
// ---------------------------------------------------------------------------

export interface OfferPublicationCandidate {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  description?: unknown;
  scopeSummary?: unknown;
  price?: unknown;
  currency?: unknown;
  status?: unknown;
  halalStatus?: unknown;
  productId?: unknown;
  product?: { name?: unknown; platform?: unknown; productUrl?: unknown } | null;
}

export interface OfferPublicationEvaluation {
  ok: boolean;
  errors: string[];
}

export function evaluateOfferPublication(candidate: OfferPublicationCandidate): OfferPublicationEvaluation {
  const errors: string[] = [];

  // 1–5. The storefront's fail-closed gate: exists, ACTIVE, HALAL, priced > 0,
  //      and passing display-time halal screening of the customer-facing text.
  const verdict = publicListingVerdict({
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    description: candidate.description,
    scopeSummary: candidate.scopeSummary,
    price: candidate.price,
    currency: candidate.currency,
    status: candidate.status,
    halalStatus: candidate.halalStatus,
  });
  errors.push(...verdict.reasons);

  // 6. Required product/delivery information: a linked Product row (delivery +
  //    webhook mapping + storefront link persistence all key off it).
  if (typeof candidate.productId !== 'string' || candidate.productId.trim().length === 0 || !candidate.product) {
    errors.push('The offer has no linked Product; Polar publication requires product/delivery information.');
  } else if (typeof candidate.product.name !== 'string' || candidate.product.name.trim().length === 0) {
    errors.push('The linked product has no name; nothing would be listed.');
  }

  // 7. Buyer-facing delivery text must exist (description or scope summary).
  const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
  const scopeSummary = typeof candidate.scopeSummary === 'string' ? candidate.scopeSummary.trim() : '';
  if (description.length === 0 && scopeSummary.length === 0) {
    errors.push('The offer has no delivery information (description or scope summary); nothing would be listed.');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * True when this offer's product already carries a verified Polar listing —
 * republishing would create a SECOND provider product for the same offer, so
 * the service refuses and reports the existing URL instead.
 */
export function isAlreadyPublishedOnPolar(product: { platform?: unknown; productUrl?: unknown } | null | undefined): boolean {
  if (!product) return false;
  const platform = typeof product.platform === 'string' ? product.platform : '';
  const url = typeof product.productUrl === 'string' ? product.productUrl : '';
  return platform === 'polar' && url.startsWith(POLAR_URL_PREFIX);
}

// ---------------------------------------------------------------------------
// Spec construction — offer facts become the adapter's publishable spec.
// Price comes from the OFFER (authoritative, already gated > 0), never from
// free text, and lands in the adapter's fixed-price minor-units payload.
// ---------------------------------------------------------------------------

export function buildOfferPublishSpec(offer: {
  id: string;
  type: string;
  title: string;
  description: string;
  scopeSummary: string;
  price: number;
}): PublishableProductSpec {
  const description = offer.description.trim();
  const scopeSummary = offer.scopeSummary.trim();
  const deliveryText = scopeSummary || description || offer.title;
  return {
    productType: offer.type,
    name: offer.title.slice(0, 190),
    targetAudience: '',
    problem: (description || deliveryText).slice(0, 600),
    valueProposition: deliveryText.slice(0, 600),
    mvpFeatures: [{ name: 'What you get', description: deliveryText.slice(0, 600), priority: 'HIGH' }],
    buildPhases: [],
    monetizationModel: 'ONE_TIME_FIXED_PRICE_PURCHASE',
    pricingHypothesis: `$${offer.price}`,
    distributionChannels: ['polar'],
    risks: [],
    assumptions: [],
    evidence: [
      {
        type: 'VERIFIED_DATA',
        content: `Offer ${offer.id} passed the fail-closed publication gate (ACTIVE, HALAL, priced, display-screened).`,
      },
    ],
    evidenceProvenance: 'USER_ENTERED',
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type OfferPublicationStatus =
  | 'PUBLISHED'
  | 'ALREADY_PUBLISHED'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'AUTH_REQUIRED'
  | 'PROVIDER_FAILED';

export interface OfferPublicationResult {
  ok: boolean;
  status: OfferPublicationStatus;
  errors?: string[];
  reason?: string;
  publicationId?: string;
  publicationUrl?: string;
}

export interface PublishOfferOptions {
  offerId: unknown;
  humanApprovalToken: unknown;
  actor: string;
  surface: string;
  /** Test seam: inject an adapter with a fake provider transport. */
  createAdapter?: () => PolarPublishingAdapter;
}

export async function publishOfferToPolar(options: PublishOfferOptions): Promise<OfferPublicationResult> {
  const { surface } = options;
  const token = typeof options.humanApprovalToken === 'string' ? options.humanApprovalToken.trim() : '';
  if (token.length === 0 || token.length > MAX_APPROVAL_TOKEN_CHARS) {
    return {
      ok: false,
      status: 'VALIDATION',
      errors: [`A human approval token (1..${MAX_APPROVAL_TOKEN_CHARS} chars) is required; nothing was published.`],
    };
  }

  const offerId = typeof options.offerId === 'string' ? options.offerId.trim() : '';
  if (offerId.length === 0 || offerId.length > 128) {
    return { ok: false, status: 'NOT_FOUND', errors: ['Unknown offer.'] };
  }

  const offer = await getOfferById(offerId);
  if (!offer) {
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: 'refused',
      detail: 'offer not found; nothing published',
    });
    return { ok: false, status: 'NOT_FOUND', errors: ['Offer not found.'] };
  }

  // The linked Product row carries the delivery name plus the existing
  // platform/productUrl fields where a verified publication is persisted.
  const productRow = offer.productId
    ? await db.product.findUnique({
        where: { id: offer.productId },
        select: { name: true, platform: true, productUrl: true },
      })
    : null;

  // Fail-closed gates (ACTIVE, HALAL, price, display screening, product,
  // delivery info) — identical rules the public storefront obeys.
  const evaluation = evaluateOfferPublication({ ...offer, product: productRow });
  if (!evaluation.ok) {
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: 'refused',
      detail: `offer=${offerId.slice(0, 12)} gates: ${evaluation.errors[0] ?? 'failed'}`.slice(0, 300),
    });
    return { ok: false, status: 'VALIDATION', errors: evaluation.errors };
  }

  // Configuration is a prerequisite, never a silent skip.
  if (!PolarPublishingAdapter.isConfigured()) {
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: 'error',
      detail: `offer=${offerId.slice(0, 12)} AUTH_REQUIRED: no provider credential`,
    });
    return {
      ok: false,
      status: 'AUTH_REQUIRED',
      errors: ['POLAR_ACCESS_TOKEN is not configured server-side; nothing was published.'],
    };
  }

  const productId = typeof offer.productId === 'string' ? offer.productId : '';
  if (!productId) {
    return { ok: false, status: 'VALIDATION', errors: ['The offer has no linked Product; nothing was published.'] };
  }

  // Idempotency: one Polar product per offer. Republish/price-change flows are
  // deliberately future work — a second product would split the buy path.
  if (isAlreadyPublishedOnPolar(productRow)) {
    const existingUrl = productRow && typeof productRow.productUrl === 'string' ? productRow.productUrl : '';
    return { ok: true, status: 'ALREADY_PUBLISHED', publicationUrl: existingUrl, reason: 'Already published; no second provider product was created.' };
  }

  const spec = buildOfferPublishSpec(offer);
  const adapter = options.createAdapter ? options.createAdapter() : new PolarPublishingAdapter();
  const validation = adapter.validate(spec);
  if (!validation.valid) {
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: 'refused',
      detail: `offer=${offerId.slice(0, 12)} spec invalid: ${validation.errors[0] ?? 'failed'}`.slice(0, 300),
    });
    return { ok: false, status: 'VALIDATION', errors: validation.errors };
  }

  // Build the provider draft, then stamp OUR linkage into its metadata so the
  // signed webhook can map a paid order back to this offer (fail-closed).
  const draft: PublishingDraft = adapter.draft(spec);
  const metadata = (typeof draft.payload.metadata === 'object' && draft.payload.metadata !== null
    ? draft.payload.metadata
    : {}) as Record<string, unknown>;
  draft.payload.metadata = { ...metadata, offerId: offer.id, productId };

  // The adapter re-checks the human token + configuration and only claims
  // "published" after a create + confirm provider round-trip.
  const attempt: PublishAttempt = await adapter.publish(draft, token);

  if (!attempt.published || !attempt.publicationId || !attempt.publicationUrl) {
    const refused = attempt.status === 'NOT_AUTHORIZED';
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: refused ? 'refused' : 'error',
      detail: `offer=${offerId.slice(0, 12)} ${attempt.status}: ${attempt.reason}`.slice(0, 300),
    });
    return refused
      ? { ok: false, status: 'VALIDATION', errors: [attempt.reason] }
      : { ok: false, status: 'PROVIDER_FAILED', reason: attempt.reason };
  }

  // Persist the verified publication into EXISTING fields only
  // (Product.platform + Product.productUrl — the storefront's Buy link).
  try {
    await db.product.update({
      where: { id: productId },
      data: { platform: 'polar', productUrl: attempt.publicationUrl },
    });
  } catch {
    await auditSecurityEvent({
      kind: 'POLAR_PUBLICATION',
      surface,
      outcome: 'error',
      detail: `offer=${offerId.slice(0, 12)} published at provider but local persistence failed`.slice(0, 300),
    });
    return {
      ok: false,
      status: 'PROVIDER_FAILED',
      reason: 'Publication was confirmed at the provider, but recording the product URL locally failed. Nothing was fabricated.',
      publicationId: attempt.publicationId,
      publicationUrl: attempt.publicationUrl,
    };
  }

  await auditSecurityEvent({
    kind: 'POLAR_PUBLICATION',
    surface,
    outcome: 'ok',
    detail: `offer=${offerId.slice(0, 12)} product=${productId.slice(0, 12)} pub=${attempt.publicationId.slice(0, 12)} approved=${credentialFingerprint(token)}`.slice(0, 300),
  });

  return {
    ok: true,
    status: 'PUBLISHED',
    publicationId: attempt.publicationId,
    publicationUrl: attempt.publicationUrl,
  };
}
