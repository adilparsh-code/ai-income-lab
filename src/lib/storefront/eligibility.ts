// ============================================================================
// STOREFRONT ELIGIBILITY (pure) — the public display gate.
// ============================================================================
// A public acquisition surface must never show something the platform would
// not sell. This module decides, deterministically and fail-closed, whether an
// Offer may appear on the storefront:
//
//   1. status must be ACTIVE        (the operator's selling gate, deny-by-default)
//   2. price must be > 0            (no free bait, no dark patterns)
//   3. halalStatus must be HALAL    (UNVERIFIED / REVIEW_REQUIRED / BLOCKED never publish)
//   4. the offer text must PASS the existing screenForHalalCompliance()
//      screening run at display time (defense in depth — an edited description
//      that now trips a prohibited keyword drops off the storefront even if
//      its stored halalStatus was set earlier).
//
// All reasons are collected (not short-circuited) so the operator's readiness
// view can explain exactly why an offer is not publicly listed.
// No database access, no I/O — unit-testable in isolation.
// ============================================================================

import { screenForHalalCompliance } from '@/lib/halal-filter';

/** Shape this module needs — a subset of the Prisma Offer row + product link. */
export interface PublicOfferCandidate {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  description?: unknown;
  scopeSummary?: unknown;
  price?: unknown;
  currency?: unknown;
  status?: unknown;
  halalStatus?: unknown;
}

export interface PublicListingVerdict {
  listable: boolean;
  /** Human-readable blockers. Empty only when the offer may be shown publicly. */
  reasons: string[];
}

/**
 * Constant screening inputs. These describe OUR storefront (not customer
 * content), so the screen sees an honest business model: a direct, fixed-price
 * sale of digital goods/services.
 */
export const STOREFRONT_BUSINESS_MODEL = 'direct sale of digital products and services';
export const STOREFRONT_MONETIZATION = 'one-time fixed-price purchase';

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/**
 * Compute the public-listing verdict for one offer. Never throws; malformed
 * input is simply "not listable" with a reason.
 */
export function publicListingVerdict(offer: PublicOfferCandidate): PublicListingVerdict {
  const reasons: string[] = [];
  // Defensive: never throw on junk input — malformed simply means "not listable".
  const candidate: PublicOfferCandidate =
    typeof offer === 'object' && offer !== null ? offer : {};

  if (!isNonEmptyString(candidate.id, 128)) reasons.push('Offer is missing a valid id.');
  if (!isNonEmptyString(candidate.title, 400)) reasons.push('Offer is missing a title.');

  if (candidate.status !== 'ACTIVE') {
    reasons.push(`Offer status is ${typeof candidate.status === 'string' && candidate.status ? candidate.status : 'unknown'} — only ACTIVE offers are published.`);
  }

  if (typeof candidate.price !== 'number' || !Number.isFinite(candidate.price) || candidate.price <= 0) {
    reasons.push('Offer has no positive price.');
  }

  if (candidate.halalStatus !== 'HALAL') {
    reasons.push(`Halal status is ${typeof candidate.halalStatus === 'string' && candidate.halalStatus ? candidate.halalStatus : 'unknown'} — only HALAL-screened offers are published.`);
  }

  // Display-time screening of the actual customer-facing text. This runs even
  // when the stored halalStatus is HALAL, so content edits cannot silently
  // move an offer into a prohibited or review-required category.
  if (isNonEmptyString(candidate.title, 400)) {
    const description = isNonEmptyString(candidate.description, 20_000) ? candidate.description : '';
    const scopeSummary = isNonEmptyString(candidate.scopeSummary, 4_000) ? candidate.scopeSummary : '';
    const type = typeof candidate.type === 'string' ? candidate.type : '';
    const screen = screenForHalalCompliance(
      candidate.title,
      `${description} ${scopeSummary}`.trim(),
      type,
      STOREFRONT_BUSINESS_MODEL,
      STOREFRONT_MONETIZATION,
    );
    if (screen.status === 'NOT_ALLOWED') {
      reasons.push(`Screening blocks this offer: ${screen.reasons.join('; ')}`);
    } else if (screen.status === 'REVIEW_REQUIRED') {
      reasons.push(`Screening requires human review before public display: ${screen.reasons.join('; ')}`);
    }
  }

  return { listable: reasons.length === 0, reasons };
}

/** Convenience predicate over publicListingVerdict(). */
export function isPubliclyListableOffer(offer: PublicOfferCandidate): boolean {
  return publicListingVerdict(offer).listable;
}
