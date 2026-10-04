// ============================================================================
// PHASE 11.2 — COMMERCIAL API: PROPOSAL DETAIL / STATE / APPROVAL / CHANGE
// ============================================================================
// GET  /api/commercial/proposals/[proposalId] → proposal + immutable versions
// POST /api/commercial/proposals/[proposalId] { action, ... }
//
//   action='approve'  → { to: 'APPROVED_FOR_SEND' | 'SEND_REFUSED' }
//   action='state'    → { to, acceptanceEvidence? }
//   action='version'  → new immutable version (never edits an existing one)
//   action='change-request' → scope change request (REVIEW_REQUIRED)
//   action='resolve-change' → { changeRequestId, to, resolvedVersionId? }
//
// Every transition is server-validated. No body field is authority: a client
// message can reach none of these paths at all.
// ============================================================================

import { NextResponse } from 'next/server';
import { requireAdminApi } from '@/lib/agency/session-guard';
import { auditSecurityEvent, clientIpFrom, enforceRateLimit, readJsonBody } from '@/lib/security/guard';
import {
  approveProposalForSend,
  createProposalVersion,
  createScopeChangeRequest,
  getProposalDetail,
  resolveScopeChangeRequest,
  transitionProposal,
} from '@/lib/commercial/proposal-service';

export const dynamic = 'force-dynamic';

const SURFACE = 'api:commercial:proposal';

export async function GET(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 60, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const { proposalId } = await params;
  const proposal = await getProposalDetail(proposalId);
  if (!proposal) return NextResponse.json({ ok: false, error: 'Proposal not found.' }, { status: 404 });
  return NextResponse.json({ ok: true, proposal });
}

export async function POST(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const ip = clientIpFrom(request);
  const limit = await enforceRateLimit({ surface: SURFACE, identity: ip, max: 30, windowSeconds: 60 });
  if (!limit.allowed) {
    await auditSecurityEvent({ kind: 'RATE_LIMITED', surface: SURFACE, outcome: 'refused' });
    return NextResponse.json({ ok: false, error: 'Rate limit exceeded. Retry later.' }, { status: 429 });
  }
  const auth = await requireAdminApi(request);
  if ('response' in auth) return auth.response;

  const bodyGuard = await readJsonBody(request, { surface: SURFACE, maxChars: 24_000 });
  if (!bodyGuard.ok) {
    return NextResponse.json({ ok: false, error: bodyGuard.error }, { status: bodyGuard.status });
  }
  const { proposalId } = await params;
  const raw = bodyGuard.value;

  if (raw.action === 'approve') {
    const result = await approveProposalForSend({ proposalId, to: raw.to, actor: auth.session.email, surface: SURFACE });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, approvalState: result.approvalState });
  }

  if (raw.action === 'state') {
    const result = await transitionProposal({
      proposalId,
      to: raw.to,
      acceptanceEvidence: raw.acceptanceEvidence,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, state: result.state });
  }

  if (raw.action === 'version') {
    const result = await createProposalVersion({
      proposalId,
      title: raw.title,
      summary: raw.summary,
      scopeItems: raw.scopeItems,
      deliverables: raw.deliverables,
      exclusions: raw.exclusions,
      assumptions: raw.assumptions,
      price: raw.price,
      currency: raw.currency,
      estimatedTimeline: raw.estimatedTimeline,
      paymentTerms: raw.paymentTerms,
      revisionAllowance: raw.revisionAllowance,
      validityDays: raw.validityDays,
      changeReason: raw.changeReason,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json(
      { ok: true, versionId: result.versionId, version: result.version },
      { status: 201 },
    );
  }

  if (raw.action === 'change-request') {
    const result = await createScopeChangeRequest({
      proposalId,
      requestedSummary: raw.requestedSummary,
      requestedDetail: raw.requestedDetail,
      sourceMessageId: raw.sourceMessageId,
      sourceFlag: raw.sourceFlag,
      estimatedHours: raw.estimatedHours,
      estimatedCost: raw.estimatedCost,
      requiresPayment: raw.requiresPayment,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json(
      { ok: true, changeRequestId: result.changeRequestId, classification: result.classification, status: result.status },
      { status: 201 },
    );
  }

  if (raw.action === 'resolve-change') {
    const result = await resolveScopeChangeRequest({
      changeRequestId: raw.changeRequestId,
      to: raw.to,
      resolvedVersionId: raw.resolvedVersionId,
      resolutionNote: raw.resolutionNote,
      actor: auth.session.email,
      surface: SURFACE,
    });
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, status: result.status });
  }

  return NextResponse.json(
    { ok: false, error: 'action must be approve, state, version, change-request, or resolve-change.' },
    { status: 400 },
  );
}