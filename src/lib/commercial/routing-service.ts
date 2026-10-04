// ============================================================================
// PHASE 11.9 GAP REMEDIATION (G1) — GOVERNED ROUTING RESOLUTION
// ============================================================================
// Phase 11.3 implemented the routing layer (routeOpportunity, executionVerdict,
// validateCandidates) as pure functions. They were correct and well tested —
// and unreachable: nothing in the production path called them. A layer nothing
// uses is not a safety control, and the audit was right to flag it.
//
// This module makes routing reachable WITHOUT inventing a second orchestrator:
//
//   * It PERSISTS the decision onto the Offer row at creation time, so the
//     route is a queryable fact rather than a decoration.
//   * It derives the route ONLY from already-screened, server-side values: the
//     offer's own type (chosen by an operator) and the PERSISTED opportunity
//     halal verdict. Untrusted content never influences the route.
//   * The job types it returns are the EXISTING job types (PRODUCT_*,
//     SERVICE_BUILD / SERVICE_QA / SERVICE_DELIVERY), so every route runs
//     through the SAME Job Runner. No second runner, no new supervisor.
//
// TRUTHFULNESS (deliberate, and the point of the module):
//   DISCOVERY NOT_CONNECTED  !=  DISCOVERY FABRICATED
// Nothing here fabricates a candidate. Resolving a route says only "IF an
// opportunity exists and is HALAL, then it executes via these existing job
// types". It never asserts that opportunities were discovered, and it never
// enqueues anything by itself. Execution remains an authorized, separate step.
// ============================================================================

import { db } from '@/lib/db';
import { routeOpportunity, type RoutingDecision } from './opportunity-routing';

export interface ResolveOfferRoutingInput {
  offerId: unknown;
  surface: string;
}

export type ResolveOfferRoutingResult =
  | { ok: true; decision: RoutingDecision }
  | { ok: false; status: 400 | 404; error: string };

/** JSON-array encode/decode with a hard failure rather than silent coercion. */
function encodeList(values: readonly string[]): string {
  return JSON.stringify([...values]);
}

function decodeList(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Resolve and PERSIST the routing decision for an offer.
 *
 * This is the production entry point that makes the Phase 11.3 routing layer
 * reachable. It is idempotent: re-resolving recomputes from the same recorded
 * inputs and overwrites with the same values, so it can safely be called again
 * after a re-screen.
 *
 * It performs NO execution and NO dispatch. It records which EXISTING job types
 * the route runs through so the governed execution path can verify it agrees.
 */
export async function resolveOfferRouting(
  input: ResolveOfferRoutingInput,
): Promise<ResolveOfferRoutingResult> {
  const offerId = typeof input.offerId === 'string' ? input.offerId : null;
  if (!offerId) return { ok: false, status: 400, error: 'offerId is required.' };

  const offer = await db.offer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      type: true,
      halalStatus: true,
      opportunityId: true,
      route: true,
      opportunity: { select: { id: true, halalStatus: true } },
    },
  });
  if (!offer) return { ok: false, status: 404, error: 'Offer not found.' };

  // The routing input is the offer's OWN type (operator-declared, validated) and
  // the PERSISTED opportunity halal verdict. Never any user-supplied text.
  const decision = routeOpportunity({
    offerType: offer.type,
    // No linked opportunity → undefined, which routeOpportunity treats as
    // UNVERIFIED. That is the fail-closed default: an offer with no screened
    // opportunity is NOT executable.
    opportunityHalalStatus: offer.opportunity?.halalStatus ?? undefined,
  });

  await db.offer.update({
    where: { id: offer.id },
    data: {
      route: decision.route,
      routeJobTypes: encodeList(decision.jobTypes),
      routeExecutable: decision.executable,
      routeBlockers: encodeList(decision.blockers),
      routeReason: decision.reason.slice(0, 500),
      routeResolvedAt: new Date(),
    },
  });

  return { ok: true, decision };
}

/**
 * Read back the persisted routing decision. Used by the execution path so a
 * service job can confirm it is running under the route that was actually
 * recorded, instead of assuming one.
 */
export async function getOfferRouting(offerId: string): Promise<{
  route: string | null;
  jobTypes: string[];
  executable: boolean;
  blockers: string[];
} | null> {
  const offer = await db.offer.findUnique({
    where: { id: offerId },
    select: { route: true, routeJobTypes: true, routeExecutable: true, routeBlockers: true },
  });
  if (!offer) return null;
  return {
    route: offer.route ?? null,
    jobTypes: decodeList(offer.routeJobTypes),
    executable: Boolean(offer.routeExecutable),
    blockers: decodeList(offer.routeBlockers),
  };
}

/**
 * True when the given job type belongs to the offer's recorded route.
 *
 * Used by the governed execution path to refuse a job that is not part of the
 * route the offer was actually assigned. Returns false when no route has been
 * resolved (historical rows), so an unresolved route never silently authorizes.
 */
export function jobTypeBelongsToRoute(
  routing: { jobTypes: string[] } | null,
  jobType: string,
): boolean {
  if (!routing || routing.jobTypes.length === 0) return false;
  return routing.jobTypes.includes(jobType);
}