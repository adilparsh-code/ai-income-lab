// ============================================================================
// STOREFRONT STORE (server) — public catalog queries + inquiry orchestration.
// ============================================================================
// Reuses existing systems only: Prisma models, client-service (Prospect /
// Conversation / Message security boundary), eligibility (pure module).
// No second product factory, no second ledger, no schema change.
// ============================================================================

import { db } from '@/lib/db';
import { auditSecurityEvent } from '@/lib/security/guard';
import {
  createConversation,
  createProspect,
  listConversationsForProspect,
  recordClientMessage,
} from '@/lib/clients/client-service';
import { publicListingVerdict, type PublicListingVerdict } from './eligibility';
import type { StoreInquiryValue } from './inquiry';

const STOREFRONT_PROVIDER = 'STOREFRONT';

const STORE_OFFER_SELECT = {
  id: true,
  type: true,
  title: true,
  description: true,
  scopeSummary: true,
  price: true,
  currency: true,
  status: true,
  halalStatus: true,
  productId: true,
  product: { select: { productUrl: true, platform: true, name: true } },
} as const;

export type StoreOffer = {
  id: string;
  type: string;
  title: string;
  description: string;
  scopeSummary: string;
  price: number;
  currency: string;
  status: string;
  halalStatus: string;
  productId: string | null;
  product: { productUrl: string; platform: string; name: string } | null;
};

const MAX_PUBLIC_OFFERS = 48;

/** Public catalog: ACTIVE + HALAL + priced offers that also pass display-time screening. */
export async function listPublicOffers(limitRaw?: number): Promise<StoreOffer[]> {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 24, MAX_PUBLIC_OFFERS));
  const rows = await db.offer.findMany({
    where: { status: 'ACTIVE', halalStatus: 'HALAL', price: { gt: 0 } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: STORE_OFFER_SELECT,
  });
  return rows.filter((row) => publicListingVerdict(row).listable) as StoreOffer[];
}

/** One publicly listable offer, or null when absent / not listable (fail closed). */
export async function getPublicOffer(offerId: unknown): Promise<StoreOffer | null> {
  if (typeof offerId !== 'string' || offerId.trim().length === 0 || offerId.length > 128) return null;
  const row = await db.offer.findUnique({ where: { id: offerId.trim() }, select: STORE_OFFER_SELECT });
  if (!row) return null;
  return publicListingVerdict(row).listable ? (row as StoreOffer) : null;
}

// ---------------------------------------------------------------------------
// Operator-facing readiness + inbound inquiry reads (served from the gated
// (admin) storefront page only — never from a public route).
// ---------------------------------------------------------------------------

export interface OfferReadiness {
  offer: StoreOffer;
  verdict: PublicListingVerdict;
}

/** Every offer with its public-listing verdict, so the operator sees exactly
 *  why an offer is (not) on the storefront. Admin-only consumer. */
export async function listOfferListingReadiness(limitRaw?: number): Promise<OfferReadiness[]> {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 50, 100));
  const rows = await db.offer.findMany({
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: STORE_OFFER_SELECT,
  });
  return rows.map((offer) => ({ offer: offer as StoreOffer, verdict: publicListingVerdict(offer) }));
}

export interface StoreInquiryRow {
  id: string;
  displayName: string;
  email: string | null;
  sourceRef: string | null;
  lifecycleState: string;
  riskState: string;
  optedOut: boolean;
  injectionFlags: number;
  createdAt: Date;
  businessInfo: string;
}

/** Inbound purchase requests captured by the storefront (source=INBOUND). */
export async function listStoreInquiries(limitRaw?: number): Promise<StoreInquiryRow[]> {
  const limit = Math.max(1, Math.min(typeof limitRaw === 'number' ? Math.floor(limitRaw) : 25, 100));
  return db.prospect.findMany({
    where: { source: 'INBOUND', sourceProvider: STOREFRONT_PROVIDER },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      displayName: true,
      email: true,
      sourceRef: true,
      lifecycleState: true,
      riskState: true,
      optedOut: true,
      injectionFlags: true,
      createdAt: true,
      businessInfo: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Inquiry orchestration — buyer request → existing inbound client pipeline.
// ---------------------------------------------------------------------------

export type StoreInquiryOutcome =
  | { ok: true; status: 'RECEIVED'; duplicate: boolean }
  | { ok: false; status: 400 | 404 | 503; error: string };

const MESSAGE_NOTE_MAX = 1_000;

/**
 * Record one storefront purchase request through EXISTING systems:
 *   1. re-verify the offer is publicly listable (fail closed, re-screened);
 *   2. Prospect (source=INBOUND, sourceProvider=STOREFRONT) — email-unique,
 *      so double submissions collapse to one lead;
 *   3. PORTAL Conversation + one immutable Message through the client-message
 *      security boundary (bounded, classified, DATA-never-authority), made
 *      idempotent with providerMessageId = storefront:<requestId>;
 *   4. one SecurityEvent audit row (no message content, no PII beyond ids).
 * Honeypot-filled submissions are acknowledged and silently dropped.
 */
export async function recordStoreInquiry(input: {
  inquiry: StoreInquiryValue;
  surface: string;
}): Promise<StoreInquiryOutcome> {
  const { inquiry, surface } = input;

  // Honeypot: acknowledge like a success so bots learn nothing.
  if (inquiry.honeypot.length > 0) {
    await auditSecurityEvent({
      kind: 'STOREFRONT_INQUIRY',
      surface,
      outcome: 'refused',
      detail: 'honeypot filled; submission dropped without writing',
    });
    return { ok: true, status: 'RECEIVED', duplicate: false };
  }

  const offer = await getPublicOffer(inquiry.offerId);
  if (!offer) {
    await auditSecurityEvent({
      kind: 'STOREFRONT_INQUIRY',
      surface,
      outcome: 'refused',
      detail: `offer not publicly listable: ${inquiry.offerId.slice(0, 12)}`,
    });
    return { ok: false, status: 404, error: 'This offer is not available right now.' };
  }

  // --- Prospect (email-unique → natural idempotency for repeat buyers) ---
  let prospectId: string | null = null;
  let createdNew = false;
  const existing = await db.prospect.findUnique({ where: { email: inquiry.email }, select: { id: true } });
  if (existing) {
    prospectId = existing.id;
  } else {
    const created = await createProspect({
      displayName: inquiry.displayName,
      email: inquiry.email,
      source: 'INBOUND',
      sourceProvider: STOREFRONT_PROVIDER,
      sourceRef: `offer:${offer.id}`,
      businessInfo: {
        interest: offer.title,
        offerId: offer.id,
        note: inquiry.message.slice(0, MESSAGE_NOTE_MAX),
      },
      evidenceRefs: [{ type: 'STOREFRONT_OFFER', id: offer.id }],
      actor: 'storefront',
      surface,
    });
    if (created.ok) {
      prospectId = created.prospectId;
      createdNew = true;
    } else if (created.status === 409) {
      // Lost a race with a concurrent submission for the same email.
      const again = await db.prospect.findUnique({ where: { email: inquiry.email }, select: { id: true } });
      if (!again) return { ok: false, status: 503, error: 'We could not record your request. Please try again shortly.' };
      prospectId = again.id;
    } else {
      return { ok: false, status: 503, error: 'We could not record your request. Please try again shortly.' };
    }
  }

  // --- PORTAL conversation (find an open one, else open one) ---
  const conversations = await listConversationsForProspect(prospectId, 20);
  const openPortal = conversations.find((c) => c.channel === 'PORTAL' && c.state === 'OPEN');
  let conversationId: string | null = openPortal?.id ?? null;
  if (!conversationId) {
    const opened = await createConversation({ prospectId, channel: 'PORTAL', actor: 'storefront', surface });
    if (!opened.ok) {
      return { ok: false, status: 503, error: 'We could not record your request. Please try again shortly.' };
    }
    conversationId = opened.conversationId;
  }

  // --- Immutable message through the existing security boundary ---
  const providerMessageId = `storefront:${inquiry.requestId}`;
  let messageResult = await recordClientMessage({
    conversationId,
    direction: 'INBOUND',
    role: 'CLIENT',
    body: inquiry.message,
    providerMessageId,
    actor: 'storefront',
    surface,
  });
  if (!messageResult.ok && messageResult.status === 409) {
    // Existing thread was closed — open a fresh one and retry exactly once.
    const reopened = await createConversation({ prospectId, channel: 'PORTAL', actor: 'storefront', surface });
    if (reopened.ok) {
      messageResult = await recordClientMessage({
        conversationId: reopened.conversationId,
        direction: 'INBOUND',
        role: 'CLIENT',
        body: inquiry.message,
        providerMessageId,
        actor: 'storefront',
        surface,
      });
    }
  }

  // The lead itself (who + which offer + note in businessInfo) is already
  // recorded; a message-pipeline failure is audited honestly but does not
  // discard the buyer's request.
  if (!messageResult.ok) {
    await auditSecurityEvent({
      kind: 'STOREFRONT_INQUIRY',
      surface,
      outcome: 'error',
      detail: `message ingest failed for offer=${offer.id.slice(0, 12)}: ${messageResult.status}`,
    });
    return { ok: true, status: 'RECEIVED', duplicate: false };
  }

  await auditSecurityEvent({
    kind: 'STOREFRONT_INQUIRY',
    surface,
    outcome: 'ok',
    detail: `offer=${offer.id.slice(0, 12)} prospect=${prospectId.slice(0, 12)} new=${createdNew} duplicate=${messageResult.duplicate}`,
  });
  return { ok: true, status: 'RECEIVED', duplicate: messageResult.duplicate };
}

