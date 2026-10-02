// ============================================================================
// PHASE 11.3 — COMMERCIAL API: ENGAGEMENT ACTIONS (admin-only)
// ============================================================================
// GET  /api/commercial/engagements/[engagementId]
// POST /api/commercial/engagements/[engagementId] { action, ... }
//
//   action='state'          → gated engagement transition (PAYMENT_VERIFIED
//                             requires a verification source)
//   action='milestone'      → create a milestone
//   action='milestone-pay'  → milestone payment transition (hard gate)
//   action='deliverable'    → create a deliverable (always starts DRAFT)
//   action='deliverable-state' → QA / delivery / acceptance transition
//   action='revision-classify' → classify a revision request WITHOUT executing
//   action='issue'          → open a service issue (human decision required)
//   action='issue-resolve'  → resolve an issue (admin only)
//   action='revenue'        → record evidence-backed revenue (hard gate)
//   action='manual-payment-verify' → controlled admin manual verification (11.4)
//   action='cost'           → record an engagement cost (11.7)
//   action='pnl'            → per-engagement P&L, actual vs estimated (11.7)
//
// PHASE 11.6: the path `engagementId` is now passed into every child-addressed
// action, so a body-supplied id belonging to a DIFFERENT engagement is refused
// rather than acted on. The engagement id in the URL is authoritative.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import {
  classifyDeliverableRevision,
  createDeliverable,
  createMilestone,
  createServiceIssue,
  getEngagementDetail,
  recordServiceRevenue,
  resolveServiceIssue,
  transitionDeliverable,
  transitionEngagement,
  transitionMilestonePayment,
} from '@/lib/commercial/engagement-service';
import { recordManualPaymentVerification } from '@/lib/commercial/payment-service';
import { getEngagementPnl, recordEngagementCost } from '@/lib/commercial/economics';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:engagement';

export async function GET(request: Request, { params }: { params: Promise<{ engagementId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { engagementId } = await params;
  const engagement = await getEngagementDetail(engagementId);
  if (!engagement) return NextResponse.json({ ok: false, error: 'Engagement not found.' }, { status: 404 });
  return NextResponse.json({ ok: true, engagement });
}

export async function POST(request: Request, { params }: { params: Promise<{ engagementId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 40, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 12_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const { engagementId } = await params;
  const raw = bodyGuard.value;

  const fail = (result: { ok: false; status: number; error: string }) =>
    NextResponse.json({ ok: false, error: result.error }, { status: result.status });

  switch (raw.action) {
    case 'state': {
      const result = await transitionEngagement({
        engagementId,
        to: raw.to,
        paymentVerificationSource: raw.paymentVerificationSource,
        paymentVerificationRef: raw.paymentVerificationRef,
        lowRiskException: raw.lowRiskException,
        actor: auth.session.email,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, state: result.state, lowRiskExceptionApplied: result.lowRiskExceptionApplied });
    }
    case 'milestone': {
      const result = await createMilestone({
        engagementId,
        key: raw.key,
        title: raw.title,
        percent: raw.percent,
        amountUsd: raw.amountUsd,
        actor: auth.session.email,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, milestoneId: result.milestoneId }, { status: 201 });
    }
    case 'milestone-pay': {
      const result = await transitionMilestonePayment({
        milestoneId: raw.milestoneId,
        engagementId,
        to: raw.to,
        paymentVerificationSource: raw.paymentVerificationSource,
        providerRef: raw.providerRef,
        actor: auth.session.email,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, paymentState: result.paymentState });
    }
    case 'deliverable': {
      const result = await createDeliverable({
        engagementId,
        title: raw.title,
        kind: raw.kind,
        milestoneKey: raw.milestoneKey,
        revisionLimit: raw.revisionLimit,
        isPreview: raw.isPreview,
        actor: auth.session.email,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, deliverableId: result.deliverableId, state: result.state }, { status: 201 });
    }
    case 'deliverable-state': {
      // The actor is explicit: QA steps must declare themselves QA, and a
      // client-acceptance record must declare its evidence. Neither is implied.
      const actor = raw.actor === 'QA' || raw.actor === 'CLIENT_EVIDENCE' ? raw.actor : 'ADMIN';
      const result = await transitionDeliverable({
        deliverableId: raw.deliverableId,
        // PHASE 11.6: the path engagement is passed in so the handler can
        // refuse a cross-engagement id instead of trusting the body.
        engagementId,
        to: raw.to,
        actor,
        revisionRequest: raw.revisionRequest,
        acceptanceEvidence: raw.acceptanceEvidence,
        artifactRefs: raw.artifactRefs,
        qaSummary: raw.qaSummary,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, state: result.state, revisionNumber: result.revisionNumber });
    }
    case 'revision-classify': {
      const result = await classifyDeliverableRevision({
        deliverableId: raw.deliverableId,
        engagementId,
        requestedSummary: raw.requestedSummary,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, classification: result.classification, reason: result.reason });
    }
    case 'issue': {
      const result = await createServiceIssue({
        engagementId,
        issueType: raw.issueType,
        summary: raw.summary,
        correlationId: raw.correlationId,
        // PHASE 11.9: the real triggering message id, validated server-side.
        messageId: raw.messageId,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, issueId: result.issueId, requiresHuman: true }, { status: 201 });
    }
    case 'issue-resolve': {
      const result = await resolveServiceIssue({
        issueId: raw.issueId,
        engagementId,
        to: raw.to,
        resolutionNote: raw.resolutionNote,
        actor: auth.session.email,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, status: result.status });
    }
    // ---- PHASE 11.4 — controlled manual payment verification -------------
    case 'manual-payment-verify': {
      const result = await recordManualPaymentVerification({
        engagementId,
        milestoneId: raw.milestoneId,
        providerRef: raw.providerRef,
        reviewer: auth.session.email,
        reason: raw.reason,
        evidenceRefs: raw.evidenceRefs,
        amountUsd: raw.amountUsd,
        currency: raw.currency,
        approved: raw.approved === true,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({
        ok: true,
        outcome: result.outcome,
        verificationId: result.verificationId,
        duplicate: result.duplicate ?? false,
      }, { status: 201 });
    }
    // ---- PHASE 11.7 — cost ledger ----------------------------------------
    case 'cost': {
      const result = await recordEngagementCost({
        engagementId,
        category: raw.category,
        amountUsd: raw.amountUsd,
        basis: raw.basis,
        description: raw.description,
        evidenceRefs: raw.evidenceRefs,
        sourceRef: raw.sourceRef,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, costId: result.costId, basis: result.basis, duplicate: result.duplicate ?? false }, { status: 201 });
    }
    // ---- PHASE 11.7 — per-engagement P&L ---------------------------------
    case 'pnl': {
      const pnl = await getEngagementPnl(engagementId);
      if (!pnl) return NextResponse.json({ ok: false, error: 'Engagement not found.' }, { status: 404 });
      return NextResponse.json({ ok: true, pnl });
    }
    case 'revenue': {
      const result = await recordServiceRevenue({
        engagementId,
        milestoneId: raw.milestoneId,
        paymentVerificationSource: raw.paymentVerificationSource,
        paymentVerificationRef: raw.paymentVerificationRef,
        revenueSource: raw.revenueSource,
        amountUsd: raw.amountUsd,
        surface: SURFACE,
      });
      if (!result.ok) return fail(result);
      return NextResponse.json({ ok: true, revenueId: result.revenueId, duplicate: result.duplicate ?? false }, { status: 201 });
    }
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action.' }, { status: 400 });
  }
}