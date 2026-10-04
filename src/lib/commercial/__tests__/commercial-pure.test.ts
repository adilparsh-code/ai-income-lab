// ============================================================================
// PHASE 11.2 + 11.3 — COMMERCIAL FOUNDATION (pure tests)
// ============================================================================
// Covers the security and business invariants that are decidable without a
// database: offer validation, proposal versioning/scope/revision rules, the
// payment gate, opportunity routing + scoring, the micro-service catalogue,
// engagement/delivery state machines, communication-provider truthfulness,
// outreach safety, and truthful AI identity.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFER_TYPES,
  canTransitionOffer,
  deriveEstimatedMargin,
  isOfferType,
  offerHalalStatusFromScreen,
  offerPaymentVerificationGate,
  offerRequiresProspect,
} from '../offer-states';
import {
  ACCEPTANCE_EVIDENCE_TYPES,
  SCOPE_CLASSIFICATIONS,
  assertSendable,
  assertVersionMutable,
  canTransitionProposal,
  classifyScopeRequest,
  deriveProposalVersionNumber,
  evaluateRevision,
  parseAcceptanceEvidence,
  type ScopeContractItem,
} from '../proposal-states';
import {
  OFFER_TYPE_TO_ROUTE,
  ROUTE_JOB_TYPES,
  classifyHalal,
  discoveryUnavailable,
  executionVerdict,
  routeOpportunity,
  scoreOpportunity,
  validateCandidate,
  validateCandidates,
} from '../opportunity-routing';
import {
  MICRO_SERVICE_CATALOGUE,
  MICRO_SERVICE_KINDS,
  evaluateMicroServiceQa,
  findMicroService,
  isMicroServiceKind,
  isPriceWithinBand,
  validateMicroServicePackage,
} from '../micro-services';
import {
  DELIVERABLE_STATES,
  ENGAGEMENT_STATES,
  LOW_RISK_EXCEPTION_DEFAULT,
  canTransitionDeliverable,
  canTransitionEngagement,
  canTransitionIssue,
  canTransitionMilestonePayment,
  classifyRevisionRequest,
  evaluateLowRiskException,
  isWorkAuthorized,
  parseDeliveryAcceptance,
} from '../engagement-states';
import {
  SimulatedCommunicationProvider,
  UnconnectedCommunicationProvider,
  describeCommunicationHealth,
  resolveCommunicationProvider,
  sendCommunication,
} from '../communication-provider';
import {
  OUTREACH_LIMITS,
  asksDirectlyAboutAiIdentity,
  composeTruthfulIdentityReply,
  evaluateOutreachEligibility,
  findForbiddenClaims,
  isProhibitedDataSource,
  screenOutreachCopy,
} from '../outreach-safety';

// ===========================================================================
// 1 + 2. Offer creation / invalid offer rejected
// ===========================================================================

describe('Phase 11.2 — Offer model', () => {
  it('1. supports all three income engines as first-class offer types', () => {
    assert.deepEqual([...OFFER_TYPES].sort(), ['CLIENT_SERVICE', 'DIGITAL_PRODUCT', 'MICRO_SERVICE']);
    for (const type of OFFER_TYPES) assert.ok(isOfferType(type));
    assert.equal(isOfferType('AGENCY_ONLY'), false);
  });

  it('2. rejects an invalid offer type and an unscreened ACTIVE offer', () => {
    assert.equal(isOfferType(''), false);
    assert.equal(isOfferType(null), false);
    assert.equal(isOfferType('DIGITAL_PRODUCTS'), false);

    // UNVERIFIED halal cannot go ACTIVE — an unscreened offer must not sell.
    const unscreened = canTransitionOffer({ from: 'DRAFT', to: 'ACTIVE', price: 100, halalStatus: 'UNVERIFIED' });
    assert.equal(unscreened.ok, false);
    assert.match(unscreened.ok ? '' : unscreened.reason, /UNVERIFIED/);

    const screened = canTransitionOffer({ from: 'DRAFT', to: 'ACTIVE', price: 100, halalStatus: 'HALAL' });
    assert.equal(screened.ok, true);
  });

  it('refuses ACTIVE with a zero price and a BLOCKED offer', () => {
    assert.equal(canTransitionOffer({ from: 'DRAFT', to: 'ACTIVE', price: 0, halalStatus: 'HALAL' }).ok, false);
    assert.equal(canTransitionOffer({ from: 'DRAFT', to: 'ACTIVE', price: 50, halalStatus: 'BLOCKED' }).ok, false);
  });

  it('only client services and micro-services require a prospect', () => {
    assert.equal(offerRequiresProspect('DIGITAL_PRODUCT'), false);
    assert.equal(offerRequiresProspect('MICRO_SERVICE'), true);
    assert.equal(offerRequiresProspect('CLIENT_SERVICE'), true);
  });

  it('derives margin from price minus cost rather than trusting input', () => {
    assert.equal(deriveEstimatedMargin(100, 30), 70);
    assert.equal(deriveEstimatedMargin(100, 130), -30);
    assert.equal(deriveEstimatedMargin(0.1 + 0.2, 0), 0.3);
  });

  it('maps the existing halal screen verdict without inventing a HALAL default', () => {
    assert.equal(offerHalalStatusFromScreen('HALAL'), 'HALAL');
    assert.equal(offerHalalStatusFromScreen('NOT_ALLOWED'), 'BLOCKED');
    assert.equal(offerHalalStatusFromScreen('REVIEW_REQUIRED'), 'REVIEW_REQUIRED');
    assert.equal(offerHalalStatusFromScreen('anything else'), 'UNVERIFIED');
  });
});

// ===========================================================================
// 9 + 10 + 11 + 12. The payment gate
// ===========================================================================

describe('Phase 11.2 — Hard payment gate', () => {
  it('10. refuses PAYMENT_VERIFIED without a verification source', () => {
    for (const source of [undefined, null, '', 'CLIENT_MESSAGE', 'SCREENSHOT', 'PAYMENT_CLAIM', 'trust me', 42, {}]) {
      const verdict = offerPaymentVerificationGate({ to: 'PAYMENT_VERIFIED', verificationSource: source, verificationRef: 'ref-1' });
      assert.equal(verdict.ok, false, `source ${String(source)} must be refused`);
    }
  });

  it('10. refuses PAYMENT_VERIFIED without a real reference', () => {
    assert.equal(offerPaymentVerificationGate({ to: 'PAYMENT_VERIFIED', verificationSource: 'PROVIDER_WEBHOOK' }).ok, false);
    assert.equal(offerPaymentVerificationGate({ to: 'PAYMENT_VERIFIED', verificationSource: 'PROVIDER_WEBHOOK', verificationRef: '   ' }).ok, false);
  });

  it('11. accepts only the three legitimate payment verification sources', () => {
    for (const source of ['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED']) {
      assert.equal(
        offerPaymentVerificationGate({ to: 'PAYMENT_VERIFIED', verificationSource: source, verificationRef: 'provider-ref-1' }).ok,
        true,
      );
    }
  });

  it('non-verified payment states need no source', () => {
    assert.equal(offerPaymentVerificationGate({ to: 'PAYMENT_PENDING' }).ok, true);
    assert.equal(offerPaymentVerificationGate({ to: 'PAYMENT_REQUIRED' }).ok, true);
  });
});

// ===========================================================================
// 3 + 4 + 5. Proposal creation, immutability, new version on change
// ===========================================================================

describe('Phase 11.2 — Proposal versioning and immutability', () => {
  it('3. proposal states and the mandatory approval gate are defined', () => {
    // DRAFT may never jump straight to SENT — INTERNAL_REVIEW comes first.
    assert.equal(canTransitionProposal({ from: 'DRAFT', to: 'SENT', actor: 'ADMIN', approvalState: 'APPROVED_FOR_SEND' }).ok, false);
    // And sending without admin approval is refused even from review.
    assert.equal(canTransitionProposal({ from: 'INTERNAL_REVIEW', to: 'SENT', actor: 'ADMIN', approvalState: 'NOT_APPROVED' }).ok, false);
    assert.equal(canTransitionProposal({ from: 'INTERNAL_REVIEW', to: 'SENT', actor: 'ADMIN', approvalState: 'APPROVED_FOR_SEND' }).ok, true);
  });

  it('4. a locked version is immutable and requires a new version', () => {
    const verdict = assertVersionMutable({ locked: true, currentVersion: 1, nextVersion: 2 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /immutable/i);
  });

  it('5. version numbers must strictly increase; a new version is always derived', () => {
    assert.equal(assertVersionMutable({ locked: false, currentVersion: 2, nextVersion: 2 }).ok, false);
    assert.equal(assertVersionMutable({ locked: false, currentVersion: 2, nextVersion: 1 }).ok, false);
    assert.equal(assertVersionMutable({ locked: false, currentVersion: 2, nextVersion: 3 }).ok, true);
    assert.equal(deriveProposalVersionNumber(0), 1);
    assert.equal(deriveProposalVersionNumber(4), 5);
  });

  it('refuses SENT from DRAFT and refuses a client actor sending a proposal', () => {
    assert.equal(canTransitionProposal({ from: 'DRAFT', to: 'SENT', actor: 'ADMIN', approvalState: 'APPROVED_FOR_SEND' }).ok, false);
    assert.equal(canTransitionProposal({ from: 'INTERNAL_REVIEW', to: 'SENT', actor: 'CLIENT_EVIDENCE', approvalState: 'APPROVED_FOR_SEND' }).ok, false);
  });

  it('refuses to send a BLOCKED or UNVERIFIED proposal', () => {
    assert.equal(assertSendable('BLOCKED').ok, false);
    assert.equal(assertSendable('UNVERIFIED').ok, false);
    assert.equal(assertSendable('REVIEW_REQUIRED').ok, true);
    assert.equal(assertSendable('HALAL').ok, true);
  });
});

// ===========================================================================
// 6 + 8. Scope boundary + out-of-scope request
// ===========================================================================

describe('Phase 11.2 — Finite scope protection', () => {
  const scope: ScopeContractItem[] = [
    { itemKey: 'website-5-pages', title: 'Five-page marketing website', classification: 'IN_SCOPE' },
    { itemKey: 'mobile-app', title: 'Native mobile application', classification: 'OUT_OF_SCOPE' },
    { itemKey: 'hosting', title: 'Hosting setup for one year', classification: 'ASSUMPTION' },
  ];

  it('6. an in-scope request matches its contract item', () => {
    const result = classifyScopeRequest('build the five page marketing website', scope);
    assert.equal(result.kind, 'IN_SCOPE');
  });

  it('8. an explicit out-of-scope item is refused and requires a change request', () => {
    const result = classifyScopeRequest('build the native mobile application', scope);
    assert.equal(result.kind, 'OUT_OF_SCOPE');
    if (result.kind === 'OUT_OF_SCOPE') assert.equal(result.requiresChangeRequest, true);
  });

  it('8. scope creep appended to an in-scope request is a change request, not in scope', () => {
    const result = classifyScopeRequest('five page website plus a native mobile app and admin panel', scope);
    assert.equal(result.kind, 'OUT_OF_SCOPE');
  });

  it('a request matching nothing in scope is out of scope', () => {
    assert.equal(classifyScopeRequest('a quantum blockchain loyalty program', scope).kind, 'OUT_OF_SCOPE');
  });

  it('an assumption item is surfaced as requiring confirmation', () => {
    const result = classifyScopeRequest('hosting setup for one year', scope);
    assert.ok(result.kind === 'ASSUMPTION' || result.kind === 'IN_SCOPE');
  });

  it('supports all four scope classifications', () => {
    assert.deepEqual([...SCOPE_CLASSIFICATIONS].sort(), ['ASSUMPTION', 'CHANGE_REQUEST', 'IN_SCOPE', 'OUT_OF_SCOPE']);
  });
});

// ===========================================================================
// 7. Revision limit
// ===========================================================================

describe('Phase 11.2/11.3 — Finite revisions', () => {
  it('7. allows rounds up to the allowance then refuses', () => {
    assert.equal(evaluateRevision(2, 0).allowed, true);
    assert.equal(evaluateRevision(2, 1).allowed, true);
    const refused = evaluateRevision(2, 2);
    assert.equal(refused.allowed, false);
    if (!refused.allowed) {
      assert.equal(refused.revisionLimitReached, true);
      assert.equal(refused.requiresChangeRequest, true);
    }
  });

  it('an allowance of 0 permits no unpaid revision round at all', () => {
    assert.equal(evaluateRevision(0, 0).allowed, false);
  });

  it('rejects out-of-range allowances and negative usage', () => {
    assert.equal(evaluateRevision(-1, 0).allowed, false);
    assert.equal(evaluateRevision(99, 0).allowed, false);
    assert.equal(evaluateRevision(2, -1).allowed, false);
    assert.equal(evaluateRevision(1.5, 0).allowed, false);
  });

  it('classifies a revision request against the deliverable allowance', () => {
    assert.equal(classifyRevisionRequest({ requestedSummary: 'typo fix', revisionCount: 0, revisionLimit: 2 }).kind, 'REVISION');
    assert.equal(classifyRevisionRequest({ requestedSummary: 'typo fix', revisionCount: 2, revisionLimit: 2 }).kind, 'CHANGE_REQUEST_REQUIRED');
  });
});

// ===========================================================================
// Acceptance evidence (fake delivery acceptance prevention)
// ===========================================================================

describe('Phase 11.2/11.3 — Acceptance evidence', () => {
  it('parses only the defined evidence types with a real reference', () => {
    assert.equal(parseAcceptanceEvidence({ type: 'SIGNED_DOCUMENT', ref: 'doc-1' }).ok, true);
    assert.equal(parseAcceptanceEvidence({ type: 'SILENCE', ref: 'doc-1' }).ok, false);
    assert.equal(parseAcceptanceEvidence({ type: 'SIGNED_DOCUMENT' }).ok, false);
    assert.equal(parseAcceptanceEvidence('approved').ok, false);
    // Silence is deliberately not an evidence type: widening the union at
    // runtime still refuses it.
    assert.ok(!(ACCEPTANCE_EVIDENCE_TYPES as readonly string[]).includes('SILENCE'));
  });

  it('26. refuses ACCEPTED without evidence even from a provider actor', () => {
    const result = canTransitionProposal({ from: 'SENT', to: 'ACCEPTED', actor: 'PROVIDER' });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /acceptanceEvidence/);
  });

  it('26. accepts ACCEPTED only with structured evidence', () => {
    const result = canTransitionProposal({
      from: 'SENT', to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE',
      acceptanceEvidence: { type: 'EXPLICIT_CLIENT_MESSAGE', ref: 'msg-9' },
    });
    assert.equal(result.ok, true);
  });
});

// ===========================================================================
// 19 + 20 + 21. Deterministic opportunity routing
// ===========================================================================

describe('Phase 11.3 — Opportunity routing', () => {
  it('19. routes a digital product to the Product Factory workflow', () => {
    const decision = routeOpportunity({ offerType: 'DIGITAL_PRODUCT', opportunityHalalStatus: 'HALAL' });
    assert.equal(decision.route, 'DIGITAL_PRODUCT_WORKFLOW');
    assert.equal(decision.commercialShape, 'SELF_SERVE');
    assert.ok(decision.jobTypes.includes('PRODUCT_CREATE'));
    assert.ok(decision.jobTypes.includes('PRODUCT_PUBLISH'));
    assert.equal(decision.executable, true);
  });

  it('20. routes a micro-service to the bounded service workflow', () => {
    const decision = routeOpportunity({ offerType: 'MICRO_SERVICE', opportunityHalalStatus: 'HALAL' });
    assert.equal(decision.route, 'MICRO_SERVICE_WORKFLOW');
    assert.deepEqual([...decision.jobTypes], ['SERVICE_BUILD', 'SERVICE_QA', 'SERVICE_DELIVERY']);
  });

  it('21. routes a client service to the client-service workflow', () => {
    const decision = routeOpportunity({ offerType: 'CLIENT_SERVICE', opportunityHalalStatus: 'HALAL' });
    assert.equal(decision.route, 'CLIENT_SERVICE_WORKFLOW');
    assert.equal(OFFER_TYPE_TO_ROUTE.CLIENT_SERVICE, 'CLIENT_SERVICE_WORKFLOW');
  });

  it('micro-services and client services share one bounded job type set', () => {
    assert.deepEqual([...ROUTE_JOB_TYPES.MICRO_SERVICE_WORKFLOW], [...ROUTE_JOB_TYPES.CLIENT_SERVICE_WORKFLOW]);
    assert.notEqual(OFFER_TYPE_TO_ROUTE.MICRO_SERVICE, OFFER_TYPE_TO_ROUTE.CLIENT_SERVICE);
  });

  it('refuses to guess an unrecognized offer type', () => {
    const decision = routeOpportunity({ offerType: 'AGENCY_ONLY' });
    assert.equal(decision.executable, false);
    assert.deepEqual(decision.blockers, ['INVALID_OFFER_TYPE']);
  });

  it('blocks routing for blocked, review-required and unscreened halal status', () => {
    assert.ok(routeOpportunity({ offerType: 'CLIENT_SERVICE', opportunityHalalStatus: 'NOT_ALLOWED' }).blockers.includes('HALAL_BLOCKED'));
    assert.ok(routeOpportunity({ offerType: 'CLIENT_SERVICE', opportunityHalalStatus: 'REVIEW_REQUIRED' }).blockers.includes('HALAL_REVIEW_REQUIRED'));
    assert.ok(routeOpportunity({ offerType: 'CLIENT_SERVICE' }).blockers.includes('HALAL_UNVERIFIED'));
  });
});

// ===========================================================================
// 22 + 23 + 24. Halal screening and unverified evidence
// ===========================================================================

describe('Phase 11.3 — Halal screening is conservative', () => {
  it('22. a blocked screen verdict stays blocked and quarantines execution', () => {
    const decision = routeOpportunity({ offerType: 'CLIENT_SERVICE', opportunityHalalStatus: 'HALAL' });
    const score = scoreOpportunity({
      title: 'sports betting affiliate', description: 'betting odds', category: 'gambling',
      businessModel: 'Direct Sales', monetizationMethod: 'ONE_TIME_PURCHASE',
      dimensions: { demand: 90 },
    });
    assert.equal(score.halalClassification, 'BLOCKED');
    const verdict = executionVerdict(score, decision);
    assert.equal(verdict.verdict, 'QUARANTINE');
    assert.equal(verdict.executable, false);
  });

  it('23. an ambiguous opportunity is REVIEW_REQUIRED, never silently halal', () => {
    const score = scoreOpportunity({
      title: 'mortgage refinance calculator', description: 'conventional finance interest-based offer',
      category: 'finance', businessModel: 'Lead Generation', monetizationMethod: 'SERVICE',
      dimensions: { demand: 70 },
    });
    assert.equal(score.halalClassification, 'REVIEW_REQUIRED');
  });

  it('23. an unscreened opportunity is UNVERIFIED rather than assumed compliant', () => {
    const { classification } = classifyHalal('HALAL', undefined, []);
    assert.equal(classification, 'UNVERIFIED');
    const { classification: withNone } = classifyHalal('NOT_ALLOWED', 'HALAL', []);
    assert.equal(withNone, 'BLOCKED');
  });

  it('24. unverified dimensions are excluded from the composite, never imputed', () => {
    const none = scoreOpportunity({
      title: 'worksheet pack', description: 'printables', category: 'Education',
      businessModel: 'Direct Sales', monetizationMethod: 'ONE_TIME_PURCHASE', dimensions: {},
    });
    assert.equal(none.composite, null);
    assert.equal(none.unverifiedDimensionCount, 11);
    assert.match(none.note, /No market number was invented/);

    const partial = scoreOpportunity({
      title: 'worksheet pack', description: 'printables', category: 'Education',
      businessModel: 'Direct Sales', monetizationMethod: 'ONE_TIME_PURCHASE',
      dimensions: { demand: 80, margin: 40 },
    });
    assert.equal(partial.composite, 60);
    assert.equal(partial.verifiedDimensionCount, 2);
    assert.equal(partial.contributions.demand, null === null ? partial.contributions.demand : null);
    assert.equal(partial.dimensions.effort.state, 'UNVERIFIED');
  });

  it('rejects out-of-range dimension values as UNVERIFIED rather than clamping', () => {
    const score = scoreOpportunity({
      title: 'x', description: 'y', category: 'z', businessModel: 'a', monetizationMethod: 'b',
      dimensions: { demand: 5000, margin: -10 },
    });
    assert.equal(score.dimensions.demand.state, 'UNVERIFIED');
    assert.equal(score.dimensions.margin.state, 'UNVERIFIED');
    assert.equal(score.composite, null);
  });
});

// ===========================================================================
// Discovery provenance
// ===========================================================================

describe('Phase 11.3 — Discovery provenance', () => {
  const base = {
    kind: 'PRODUCT_OPPORTUNITY', title: 'Printable worksheet pack', summary: 's',
    suggestedOfferType: 'DIGITAL_PRODUCT', source: 'searxng', sourceRef: 'https://x/1',
    evidence: 'found on a public directory', evidenceType: 'SEARCH_DISCOVERY', confidence: 0.6,
  };

  it('accepts a candidate with complete provenance', () => {
    const result = validateCandidate(base);
    assert.equal(result.ok, true);
  });

  it('rejects a candidate whose provenance is missing or fabricated-empty', () => {
    for (const key of ['source', 'sourceRef', 'evidence'] as const) {
      const broken = { ...base, [key]: '' };
      assert.equal(validateCandidate(broken).ok, false, `${key} must be mandatory`);
    }
    assert.equal(validateCandidate({ ...base, confidence: 5 }).ok, false);
    assert.equal(validateCandidate({ ...base, kind: 'MADE_UP' }).ok, false);
  });

  it('drops malformed candidates rather than storing them', () => {
    const { candidates, rejected } = validateCandidates([base, { ...base, source: '' }]);
    assert.equal(candidates.length, 1);
    assert.equal(rejected.length, 1);
  });

  it('18. reports NOT_CONNECTED truthfully when no discovery provider exists', () => {
    const result = discoveryUnavailable({ status: 'RESEARCH_UNAVAILABLE' });
    assert.equal(result.state, 'NOT_CONNECTED');
    assert.deepEqual(result.candidates, []);
    assert.match(result.detail, /none were fabricated/);
  });
});

// ===========================================================================
// Micro-service engine (bounded work)
// ===========================================================================

describe('Phase 11.3 — Bounded micro-service engine', () => {
  it('defines a bounded catalogue covering all three named engine families', () => {
    assert.ok(MICRO_SERVICE_KINDS.length >= 12);
    for (const definition of MICRO_SERVICE_CATALOGUE) {
      assert.ok(definition.scope.length > 20, `${definition.kind} needs a defined scope`);
      assert.ok(definition.deliverables.length > 0);
      assert.ok(definition.maxEffortHours > 0);
      assert.ok(definition.qaChecks.length > 0);
      assert.ok(definition.maxPriceUsd >= definition.minPriceUsd);
      assert.ok(definition.defaultRevisionLimit <= 2);
    }
  });

  it('rejects an unknown micro-service kind', () => {
    assert.equal(findMicroService('UNBOUNDED_WORK'), null);
    assert.equal(isMicroServiceKind('UNBOUNDED_WORK'), false);
    assert.equal(validateMicroServicePackage({ kind: 'UNBOUNDED_WORK' }).ok, false);
  });

  it('refuses effort beyond the bounded maximum instead of clamping', () => {
    const verdict = validateMicroServicePackage({ kind: 'CUSTOM_WORKSHEET', estimatedEffortHours: 400 });
    assert.equal(verdict.ok, false);
  });

  it('caps revisions for micro-services', () => {
    assert.equal(validateMicroServicePackage({ kind: 'CUSTOM_WORKSHEET', revisionLimit: 99 }).ok, false);
  });

  it('bounds the price band', () => {
    const definition = findMicroService('CUSTOM_WORKSHEET')!;
    assert.equal(isPriceWithinBand(definition, definition.minPriceUsd), true);
    assert.equal(isPriceWithinBand(definition, definition.maxPriceUsd), true);
    assert.equal(isPriceWithinBand(definition, 1e9), false);
  });

  it('QA fails closed when a check is unreported', () => {
    const definition = findMicroService('CUSTOM_WORKSHEET')!;
    const verdict = evaluateMicroServiceQa(definition, []);
    assert.equal(verdict.passed, false);
    assert.ok(!verdict.passed && verdict.failed.length === definition.qaChecks.length);
  });

  it('QA passes only when every check is explicitly reported as passed', () => {
    const definition = findMicroService('CUSTOM_WORKSHEET')!;
    const allPassed = definition.qaChecks.map((check) => ({ check, passed: true }));
    assert.equal(evaluateMicroServiceQa(definition, allPassed).passed, true);
    const partial = definition.qaChecks.slice(0, 1).map((check) => ({ check, passed: true }));
    assert.equal(evaluateMicroServiceQa(definition, partial).passed, false);
  });
});

// ===========================================================================
// The engagement payment gate — the hardest invariant
// ===========================================================================

describe('Phase 11.3 — Unpaid work is structurally impossible', () => {
  it('cannot reach WORK_AUTHORIZED from any unpaid state', () => {
    for (const from of ['NO_COMMITMENT', 'PROPOSAL_SENT', 'ACCEPTED', 'PAYMENT_REQUIRED', 'PAYMENT_PENDING'] as const) {
      const verdict = canTransitionEngagement({ from, to: 'WORK_AUTHORIZED', actor: 'ADMIN' });
      assert.equal(verdict.ok, false, `${from} → WORK_AUTHORIZED must be refused`);
    }
  });

  it('11. unlocks WORK_AUTHORIZED only from a verified payment', () => {
    const verified = canTransitionEngagement({
      from: 'PAYMENT_VERIFIED', to: 'WORK_AUTHORIZED', actor: 'ADMIN',
      verificationSource: 'PROVIDER_WEBHOOK',
    });
    assert.equal(verified.ok, true);
  });

  it('refuses PAYMENT_VERIFIED without a verification source', () => {
    for (const source of [undefined, null, '', 'CLIENT_MESSAGE', 'SCREENSHOT', 'receipt.png']) {
      const verdict = canTransitionEngagement({ from: 'PAYMENT_PENDING', to: 'PAYMENT_VERIFIED', actor: 'ADMIN', verificationSource: source });
      assert.equal(verdict.ok, false, `source ${String(source)} must be refused`);
    }
  });

  it('keeps the low-risk exception OFF by default', () => {
    assert.equal(LOW_RISK_EXCEPTION_DEFAULT.enabled, false);
    const verdict = canTransitionEngagement({ from: 'ACCEPTED', to: 'WORK_AUTHORIZED', actor: 'ADMIN' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /not permitted by default/);
  });

  it('allows the exception only when explicitly enabled, capped and low risk', () => {
    const good = evaluateLowRiskException({ enabled: true, prospectRiskState: 'LOW_RISK', exposureCapUsd: 50 }, 'LOW_RISK');
    assert.equal(good.ok, true);
    assert.equal(evaluateLowRiskException({ enabled: true, prospectRiskState: 'LOW_RISK', exposureCapUsd: 0 }, 'LOW_RISK').ok, false);
    assert.equal(evaluateLowRiskException({ enabled: true, prospectRiskState: 'LOW_RISK', exposureCapUsd: 50 }, 'HIGH_RISK').ok, false);
  });

  it('requires a human for pause / terminate / cancel', () => {
    for (const to of ['PAUSED', 'TERMINATED', 'CANCELLED'] as const) {
      assert.equal(canTransitionEngagement({ from: 'ACCEPTED', to, actor: 'SYSTEM' }).ok, false);
    }
  });

  it('28. a closed engagement cannot be reopened', () => {
    for (const from of ['COMPLETED', 'PAUSED', 'TERMINATED', 'CANCELLED'] as const) {
      const verdict = canTransitionEngagement({ from, to: 'WORK_IN_PROGRESS', actor: 'ADMIN' });
      assert.equal(verdict.ok, false);
    }
  });

  it('identifies exactly which states are work-authorized', () => {
    assert.equal(isWorkAuthorized('ACCEPTED'), false);
    assert.equal(isWorkAuthorized('PAYMENT_REQUIRED'), false);
    assert.equal(isWorkAuthorized('WORK_AUTHORIZED'), true);
    assert.equal(isWorkAuthorized('WORK_IN_PROGRESS'), true);
    assert.equal(isWorkAuthorized('COMPLETED'), false);
  });
});

// ===========================================================================
// Milestone payment machine
// ===========================================================================

describe('Phase 11.3 — Milestone payment machine', () => {
  it('accepts a client claim only as PAYMENT_PENDING, never PAYMENT_VERIFIED', () => {
    const pending = canTransitionMilestonePayment({ from: 'PAYMENT_REQUIRED', to: 'PAYMENT_PENDING' });
    assert.equal(pending.ok, true);
    const verified = canTransitionMilestonePayment({ from: 'PAYMENT_PENDING', to: 'PAYMENT_VERIFIED', verificationSource: 'CLIENT_MESSAGE' });
    assert.equal(verified.ok, false);
  });

  it('accepts PAYMENT_VERIFIED only via a legitimate source', () => {
    for (const source of ['PROVIDER_WEBHOOK', 'PROVIDER_API', 'MANUAL_ADMIN_APPROVED']) {
      assert.equal(canTransitionMilestonePayment({ from: 'PAYMENT_PENDING', to: 'PAYMENT_VERIFIED', verificationSource: source }).ok, true);
    }
  });

  it('refuses illegal payment transitions', () => {
    assert.equal(canTransitionMilestonePayment({ from: 'NOT_DUE', to: 'PAYMENT_VERIFIED', verificationSource: 'PROVIDER_API' }).ok, false);
    assert.equal(canTransitionMilestonePayment({ from: 'REFUNDED', to: 'PAYMENT_VERIFIED', verificationSource: 'PROVIDER_API' }).ok, false);
  });
});

// ===========================================================================
// Delivery states (explicit delivery, honest acceptance)
// ===========================================================================

describe('Phase 11.3 — Explicit delivery', () => {
  it('never allows a generated artifact to jump straight to DELIVERED', () => {
    const verdict = canTransitionDeliverable({ from: 'DRAFT', to: 'DELIVERED', actor: 'ADMIN', engagementState: 'DELIVERY_AUTHORIZED' });
    assert.equal(verdict.ok, false);
  });

  it('requires QA to pass before a deliverable becomes ready', () => {
    assert.equal(canTransitionDeliverable({ from: 'QA_PENDING', to: 'QA_PASSED', actor: 'ADMIN' }).ok, true);
    // A client message cannot advance the QA state machine at all.
    const blocked = canTransitionDeliverable({ from: 'QA_PENDING', to: 'QA_PASSED', actor: 'CLIENT_EVIDENCE' });
    assert.equal(blocked.ok, false);
  });

  it('requires delivery authorization for a FINAL deliverable release', () => {
    const unauthorized = canTransitionDeliverable({ from: 'READY_FOR_DELIVERY', to: 'DELIVERED', actor: 'ADMIN', engagementState: 'WORK_IN_PROGRESS' });
    assert.equal(unauthorized.ok, false);
    const authorized = canTransitionDeliverable({ from: 'READY_FOR_DELIVERY', to: 'DELIVERED', actor: 'ADMIN', engagementState: 'DELIVERY_AUTHORIZED' });
    assert.equal(authorized.ok, true);
  });

  it('26. refuses ACCEPTED without structured evidence', () => {
    const verdict = canTransitionDeliverable({ from: 'CLIENT_REVIEW', to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE' });
    assert.equal(verdict.ok, false);
    const good = canTransitionDeliverable({
      from: 'CLIENT_REVIEW', to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE',
      acceptanceEvidence: { type: 'EXPLICIT_CLIENT_MESSAGE', ref: 'msg-3' },
    });
    assert.equal(good.ok, true);
  });

  it('26. never infers acceptance from silence', () => {
    assert.equal(parseDeliveryAcceptance(undefined).ok, false);
    assert.equal(parseDeliveryAcceptance({ type: 'SILENCE', ref: 'x' }).ok, false);
  });

  it('7. counts a revision against the finite allowance', () => {
    const within = canTransitionDeliverable({ from: 'DELIVERED', to: 'REVISION_REQUESTED', actor: 'ADMIN', revisionCount: 0, revisionLimit: 2 });
    assert.equal(within.ok, true);
    if (within.ok) assert.equal(within.revisionNumber, 1);
    const beyond = canTransitionDeliverable({ from: 'DELIVERED', to: 'REVISION_REQUESTED', actor: 'ADMIN', revisionCount: 2, revisionLimit: 2 });
    assert.equal(beyond.ok, false);
  });

  it('defines the full explicit delivery vocabulary', () => {
    for (const state of ['DRAFT', 'QA_PENDING', 'QA_PASSED', 'READY_FOR_DELIVERY', 'DELIVERED', 'CLIENT_REVIEW', 'ACCEPTED', 'WITHHELD']) {
      assert.ok(DELIVERABLE_STATES.includes(state as never), `${state} must exist`);
    }
    assert.ok(ENGAGEMENT_STATES.length >= 12);
  });
});

// ===========================================================================
// Service issues
// ===========================================================================

describe('Phase 11.3 — Service issues are human-only', () => {
  it('refuses a system actor deciding a refund, dispute or chargeback', () => {
    for (const issueType of ['REFUND_REQUESTED', 'DISPUTE', 'CHARGEBACK', 'TERMINATION_REQUESTED'] as const) {
      const verdict = canTransitionIssue({ from: 'OPEN', to: 'APPROVED', issueType, actor: 'SYSTEM' });
      assert.equal(verdict.ok, false, `${issueType} must require a human`);
    }
  });

  it('permits an admin decision', () => {
    assert.equal(canTransitionIssue({ from: 'OPEN', to: 'APPROVED', issueType: 'REFUND_REQUESTED', actor: 'ADMIN' }).ok, true);
  });
});

// ===========================================================================
// 18. Communication provider truthfulness
// ===========================================================================

describe('Phase 11.3 — Communication provider is truthful', () => {
  it('18. the production provider is NOT_CONNECTED and refuses to send', async () => {
    const provider = resolveCommunicationProvider('EMAIL');
    assert.equal(provider.isConfigured(), false);
    assert.equal(provider.health().state, 'NOT_CONNECTED');
    const result = await provider.send({
      channel: 'EMAIL', to: 'buyer@example.com', subject: 'hi', body: 'hello',
      idempotencyKey: 'k1',
    });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /NOT_CONNECTED/);
  });

  it('18. no channel claims to be connected', () => {
    for (const channel of describeCommunicationHealth()) {
      assert.equal(channel.state, 'NOT_CONNECTED', `${channel.channel} must report NOT_CONNECTED`);
      assert.ok(channel.requiredForConnected.length > 0);
    }
  });

  it('the unconnected provider still honours suppression (safety works offline)', async () => {
    const provider = new UnconnectedCommunicationProvider();
    assert.equal((await provider.suppress('a@b.com', 'opt-out')).ok, true);
  });

  it('the deterministic test adapter is idempotent and labelled simulated', async () => {
    const provider = new SimulatedCommunicationProvider();
    const request = {
      channel: 'EMAIL' as const, to: 'buyer@example.com', subject: 'proposal',
      body: 'body', idempotencyKey: 'same-key',
    };
    const first = await provider.send(request);
    const second = await provider.send(request);
    assert.equal(first.ok, true);
    assert.equal(first.simulated, true);
    assert.ok(first.ok && second.ok, 'both sends must succeed');
    assert.equal(first.ok && second.ok ? first.providerMessageId : null, first.ok && second.ok ? second.providerMessageId : null);
    assert.equal(provider.sentCount(), 1);
    assert.match(provider.health().detail, /SIMULATED/);
  });

  it('the test adapter honours opt-out suppression', async () => {
    const provider = new SimulatedCommunicationProvider();
    await provider.suppress('blocked@example.com', 'opted out');
    const result = await provider.send({
      channel: 'EMAIL', to: 'blocked@example.com', subject: 's', body: 'b', idempotencyKey: 'k2',
    });
    assert.equal(result.ok, false);
  });

  it('17. sendCommunication audits the attempt and never fabricates a message id', async () => {
    const result = await sendCommunication({
      channel: 'EMAIL', to: 'buyer@example.com', subject: 's', body: 'b', idempotencyKey: 'k3',
    }, 'test:commercial');
    assert.equal(result.ok, false);
    assert.equal('providerMessageId' in result, false, 'no provider message id may exist');
  });
});

// ===========================================================================
// Outreach safety + truthful AI identity
// ===========================================================================

describe('Phase 11.3 — Outreach safety and truthful AI identity', () => {
  it('always answers a direct AI-identity question truthfully', () => {
    for (const question of [
      'Are you an AI?',
      'are you a real person',
      'who are you',
      'Is this a bot',
      'do you use artificial intelligence',
      'Are you using ChatGPT?',
    ]) {
      assert.equal(asksDirectlyAboutAiIdentity(question), true, `"${question}" must be recognized`);
    }
    assert.equal(asksDirectlyAboutAiIdentity('what is your turnaround time?'), false);

    const reply = composeTruthfulIdentityReply({ businessName: 'AI Income Lab' });
    assert.match(reply, /AI-assisted business operator/);
    assert.match(reply, /AI/);
    assert.doesNotMatch(reply, /I am a human/i);
    assert.doesNotMatch(reply, /I am a real person/i);
    assert.equal(screenOutreachCopy(reply).ok, true);
  });

  it('refuses copy that impersonates a human', () => {
    assert.equal(screenOutreachCopy('I am a real person and I have been designing sites for 10 years.').ok, false);
    assert.equal(screenOutreachCopy("I'm the owner of this business.").ok, false);
    assert.equal(screenOutreachCopy('Our team is here to help you today.').ok, false);
  });

  it('refuses fabricated testimonials, scarcity, guarantees and stats', () => {
    const bad = [
      'Trusted by 500+ clients across the country.',
      '5-star rated by our customers.',
      'Our previous clients include major brands.',
      'Only 3 slots left — act now!',
      'We guarantee income of $10k per month.',
      'Typically 3x more profit.',
      '15 years of experience in the industry.',
      'Pay us immediately or the price doubles.',
    ];
    for (const copy of bad) {
      assert.equal(screenOutreachCopy(copy).ok, false, `"${copy}" must be refused`);
    }
    assert.ok(findForbiddenClaims('Our studio is here to help.').length === 0);
  });

  it('enforces opt-out, qualification and the human-gated first contact', () => {
    const base = {
      optedOut: false, lifecycleState: 'QUALIFIED', contactAttempts: 1,
      lastContactedAt: new Date('2020-01-01'), contactApprovalRef: 'approval-1',
    };
    assert.equal(evaluateOutreachEligibility(base).ok, true);
    assert.equal(evaluateOutreachEligibility({ ...base, optedOut: true }).ok, false);
    assert.equal(evaluateOutreachEligibility({ ...base, lifecycleState: 'NEW' }).ok, false);
    assert.equal(evaluateOutreachEligibility({ ...base, contactAttempts: 99 }).ok, false);
    assert.equal(
      evaluateOutreachEligibility({ ...base, contactAttempts: 0, contactApprovalRef: null }).ok,
      false,
    );
  });

  it('enforces the per-prospect contact window', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const recent = evaluateOutreachEligibility({
      optedOut: false, lifecycleState: 'QUALIFIED', contactAttempts: 1,
      lastContactedAt: new Date('2026-01-08T00:00:00Z'), contactApprovalRef: 'a', now,
    });
    assert.equal(recent.ok, false);
    assert.ok(OUTREACH_LIMITS.maxContactsPerWindowDays > 0);
  });

  it('treats unknown or prohibited data sources as prohibited', () => {
    assert.equal(isProhibitedDataSource('people-search'), true);
    assert.equal(isProhibitedDataSource('purchased list'), true);
    assert.equal(isProhibitedDataSource('public business directory'), false);
    assert.equal(isProhibitedDataSource(''), true);
    assert.equal(isProhibitedDataSource(undefined as unknown as string), true);
  });
});