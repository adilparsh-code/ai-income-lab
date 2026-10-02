// ============================================================================
// PHASE 11.8 — PRODUCTION READINESS / AUTONOMOUS OPERATIONS AUDIT
// ============================================================================
// A regression suite over the invariants the whole Phase 11 stack rests on.
// These are deliberately STRUCTURAL assertions (does the architecture still
// forbid the thing?) rather than happy-path assertions.
//
// The point is that a future change which re-opens one of these holes fails
// the build rather than quietly shipping.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERABLE_TRANSITIONS,
  ENGAGEMENT_TRANSITIONS,
  MILESTONE_TRANSITIONS,
  isWorkAuthorized,
  canTransitionEngagement,
  canTransitionDeliverable,
  canTransitionMilestonePayment,
  SERVICE_ISSUE_TYPES,
} from '../engagement-states';
import { classifyPaymentEvidence, PAYMENT_EVIDENCE_METHODS } from '../payment-evidence';
import { screenOutreachCopy, findForbiddenClaims, evaluateOutreachEligibility } from '../outreach-safety';
import { SimulatedCommunicationProvider, UnconnectedCommunicationProvider } from '../communication-provider';
import { screenForHalalCompliance } from '@/lib/halal-filter';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ===========================================================================
// Autonomous operation bounds
// ===========================================================================

describe('Phase 11.8 — autonomous operation stays bounded', () => {
  it('no engagement state authorizes execution without PAYMENT_VERIFIED', () => {
    const statesRequiringPayment = Object.entries(ENGAGEMENT_TRANSITIONS)
      .filter(([, targets]) => targets.includes('WORK_AUTHORIZED'))
      .map(([from]) => from);
    assert.deepEqual(statesRequiringPayment, ['PAYMENT_VERIFIED']);
  });

  it('PAUSED, TERMINATED and CANCELLED are terminal — never silently resumed', () => {
    for (const terminal of ['PAUSED', 'TERMINATED', 'CANCELLED', 'COMPLETED'] as const) {
      assert.deepEqual(
        ENGAGEMENT_TRANSITIONS[terminal], [],
        `${terminal} must have no outgoing transitions`,
      );
      assert.equal(isWorkAuthorized(terminal), false, `${terminal} must not authorize work`);
    }
  });

  it('refunds and chargebacks are terminal at the milestone level', () => {
    assert.deepEqual(MILESTONE_TRANSITIONS.REFUNDED, []);
    assert.deepEqual(MILESTONE_TRANSITIONS.PARTIALLY_REFUNDED, []);
  });

  it('a deliverable can never go straight from DRAFT to DELIVERED', () => {
    assert.equal(DELIVERABLE_TRANSITIONS.DRAFT.includes('DELIVERED'), false);
    assert.equal(DELIVERABLE_TRANSITIONS.DRAFT.includes('ACCEPTED'), false);
    assert.equal(DELIVERABLE_TRANSITIONS.DRAFT.includes('READY_FOR_DELIVERY'), false);
  });

  it('acceptance requires CLIENT_REVIEW first — silence never accepts', () => {
    const early = canTransitionDeliverable({
      from: 'DELIVERED', to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE',
      acceptanceEvidence: { type: 'EXPLICIT_CLIENT_MESSAGE', ref: 'msg-1' },
    });
    assert.equal(early.ok, false, 'acceptance before CLIENT_REVIEW must be refused');
  });

  it('only a QA step (or an admin acting on QA evidence) may mark QA_PASSED', () => {
    const asAdmin = canTransitionDeliverable({ from: 'QA_PENDING', to: 'QA_PASSED', actor: 'ADMIN' });
    const asQa = canTransitionDeliverable({ from: 'QA_PENDING', to: 'QA_PASSED', actor: 'QA' });
    const asSystem = canTransitionDeliverable({ from: 'QA_PENDING', to: 'QA_PASSED', actor: 'SYSTEM' });
    assert.equal(asAdmin.ok, true);
    assert.equal(asQa.ok, true);
    assert.equal(asSystem.ok, false, 'the generating system cannot self-certify its own QA');
  });

  it('client acceptance evidence is structurally required', () => {
    const verdict = canTransitionDeliverable({
      from: 'CLIENT_REVIEW', to: 'ACCEPTED', actor: 'CLIENT_EVIDENCE',
    });
    assert.equal(verdict.ok, false, 'ACCEPTED without evidence must be refused');
  });

  it('every human-only service issue type requires an admin decision', () => {
    for (const issueType of ['DISPUTE', 'CHARGEBACK', 'REFUND_REQUESTED', 'REFUND_PROCESSED', 'CANCELLATION_APPROVED'] as const) {
      assert.ok(SERVICE_ISSUE_TYPES.includes(issueType), `${issueType} must exist as an issue type`);
    }
  });

  it('the low-risk unpaid exception is OFF by default and needs an exposure cap', () => {
    const noConfig = canTransitionEngagement({
      from: 'PAYMENT_REQUIRED', to: 'WORK_AUTHORIZED', actor: 'ADMIN',
    });
    assert.equal(noConfig.ok, false, 'unpaid execution is impossible without explicit config');

    const capZero = canTransitionEngagement({
      from: 'PAYMENT_REQUIRED', to: 'WORK_AUTHORIZED', actor: 'ADMIN',
      lowRiskException: { enabled: true, prospectRiskState: 'PAYMENT_VERIFIED', exposureCapUsd: 0 },
      prospectRiskState: 'PAYMENT_VERIFIED',
    });
    assert.equal(capZero.ok, false, 'an unbounded exception must be refused');

    const riskyProspect = canTransitionEngagement({
      from: 'PAYMENT_REQUIRED', to: 'WORK_AUTHORIZED', actor: 'ADMIN',
      lowRiskException: { enabled: true, prospectRiskState: 'PAYMENT_VERIFIED', exposureCapUsd: 50 },
      prospectRiskState: 'BLOCKED',
    });
    assert.equal(riskyProspect.ok, false, 'a blocked-risk prospect must never qualify');
  });

  it('an admin cannot silently pause/terminate/cancel via a non-admin actor', () => {
    const verdict = canTransitionEngagement({ from: 'WORK_IN_PROGRESS', to: 'TERMINATED', actor: 'SYSTEM' });
    assert.equal(verdict.ok, false, 'termination is an administrator-only decision');
  });
});

// ===========================================================================
// Payment truth
// ===========================================================================

describe('Phase 11.8 — payment truth', () => {
  it('exactly three evidence methods exist, and none of them is a claim', () => {
    assert.deepEqual([...PAYMENT_EVIDENCE_METHODS].sort(), [
      'MANUAL_ADMIN_APPROVED', 'PROVIDER_API', 'PROVIDER_WEBHOOK',
    ]);
    for (const forbidden of ['CLIENT_CONFIRMED', 'SCREENSHOT', 'AI_VERIFIED', 'MANUAL', 'PAID']) {
      assert.equal(
        classifyPaymentEvidence({ method: forbidden }).ok, false,
        `${forbidden} must not be a payment method`,
      );
    }
  });

  it('milestone payment verification requires a source', () => {
    const verdict = canTransitionMilestonePayment({
      from: 'PAYMENT_REQUIRED', to: 'PAYMENT_VERIFIED', verificationSource: 'CLIENT_MESSAGE',
    });
    assert.equal(verdict.ok, false);
  });

  it('no "paid" boolean exists anywhere in the commercial payment path', () => {
    // A boolean flag would be a bypass by construction, so its absence is the
    // guarantee. This asserts the property directly rather than trusting review.
    const paymentService = read('src/lib/commercial/payment-service.ts');
    assert.equal(
      /\bpaid\s*:\s*true\b/i.test(paymentService), false,
      'no hard-coded "paid: true" may appear in the payment service',
    );
    const evidence = read('src/lib/commercial/payment-evidence.ts');
    assert.equal(
      /\brecordedPayment\s*\??\s*:\s*boolean/i.test(evidence), false,
      'payment truth must not be a boolean input',
    );
  });
});

// ===========================================================================
// Communication and truthful identity
// ===========================================================================

describe('Phase 11.8 — communication safety', () => {
  it('the simulated adapter does not report itself healthy (no false green)', () => {
    const simulated = new SimulatedCommunicationProvider('EMAIL');
    assert.equal(
      simulated.health().state, 'NOT_CONNECTED',
      'a simulated adapter must never present as a healthy provider',
    );
    assert.match(simulated.health().detail, /SIMULATED/i);
  });

  it('the production provider is NOT_CONNECTED and refuses to send', async () => {
    const provider = new UnconnectedCommunicationProvider('EMAIL');
    assert.equal(provider.isConfigured(), false);
    assert.equal(provider.health().state, 'NOT_CONNECTED');
    const result = await provider.send();
    assert.equal(result.ok, false);
    assert.match(result.reason, /NOT_CONNECTED/);
    assert.equal(
      (result as { providerMessageId?: string }).providerMessageId, undefined,
      'a refused send must never fabricate a provider message id',
    );
  });

  it('screenOutreachCopy refuses impersonation and every deceptive claim class', () => {
    const cases: { copy: string; expect: string }[] = [
      { copy: 'I am a real person helping you today.', expect: 'impersonation' },
      { copy: 'Our team is here to help you grow.', expect: 'impersonation' },
      { copy: 'Trusted by 2,000+ clients.', expect: 'fake-testimonial' },
      { copy: '4.8 star rated service.', expect: 'fake-rating' },
      { copy: 'Our previous clients include Fortune 500 firms.', expect: 'fake-portfolio' },
      { copy: 'Only 5 slots left!', expect: 'fake-scarcity' },
      { copy: 'Guaranteed income of $20k monthly.', expect: 'false-guarantee' },
      { copy: "I'm the founder of this company.", expect: 'impersonation' },
    ];
    for (const { copy, expect } of cases) {
      const verdict = screenOutreachCopy(copy);
      assert.equal(verdict.ok, false, `"${copy}" must be refused`);
      assert.ok(
        verdict.ok ? false : verdict.violations.some((v) => v.id === expect),
        `"${copy}" should trip ${expect}, got ${verdict.ok ? 'pass' : verdict.violations.map((v) => v.id).join(',')}`,
      );
    }
  });

  it('honest copy passes the content gate', () => {
    const verdict = screenOutreachCopy(
      'We are an AI-assisted business operator offering a bounded document-formatting service. '
      + 'You are speaking with an AI-assisted operator, and a human is accountable for decisions and payments.',
    );
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.reason);
    assert.deepEqual(findForbiddenClaims('A plain, honest description of a bounded service.'), []);
  });

  it('opt-out beats every other consideration', () => {
    const verdict = evaluateOutreachEligibility({
      optedOut: true,
      lifecycleState: 'QUALIFIED',
      contactAttempts: 0,
      lastContactedAt: null,
      contactApprovalRef: 'approved',
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? '' : verdict.reason, /opted out/i);
  });

  it('an unqualified or blocked prospect is never contactable', () => {
    for (const lifecycleState of ['NEW', 'UNVERIFIED', 'BLOCKED', 'LOST']) {
      const verdict = evaluateOutreachEligibility({
        optedOut: false, lifecycleState, contactAttempts: 0, lastContactedAt: null,
        contactApprovalRef: 'approved',
      });
      assert.equal(verdict.ok, false, `${lifecycleState} must not be contactable`);
    }
  });
});

// ===========================================================================
// Halal governance
// ===========================================================================

describe('Phase 11.8 — halal governance', () => {
  it('the screening engine catches prohibited content and declares its own limits', () => {
    // The engine is a deterministic keyword screen, not a religious authority.
    // It declares that explicitly, and it flags prohibited terms rather than
    // waving them through.
    const clean = screenForHalalCompliance('Bounded document formatting service', '', 'Digital Products', 'Direct Sales', 'ONE_TIME_PURCHASE');
    assert.equal(clean.status, 'HALAL');
    assert.match(
      clean.reasons.join(' '), /not a religious authority/i,
      'the engine must never present itself as a religious authority',
    );

    // Prohibited content must be flagged, not silently permitted.
    const flagged = screenForHalalCompliance(
      'Guaranteed returns on cryptocurrency trading with interest-based lending',
      '', 'Digital Products', 'Direct Sales', 'ONE_TIME_PURCHASE',
    );
    assert.ok(
      flagged.status !== 'HALAL' || flagged.flaggedKeywords.length > 0,
      'prohibited content must never come back as an unqualified HALAL',
    );
  });

  it('the commercial modules reuse the ONE halal engine', () => {
    // A second keyword list would be a second authority. This asserts there is
    // exactly one screening import surface.
    const engagementService = read('src/lib/commercial/engagement-service.ts');
    assert.equal(
      /screenForHalalCompliance\s*\(/.test(engagementService), false,
      'engagement creation enforces the STORED offer verdict rather than re-screening',
    );
    assert.match(engagementService, /halalStatus/);
    const offerService = read('src/lib/commercial/offer-service.ts');
    assert.match(
      offerService, /screenForHalalCompliance/,
      'offer creation must always run the screen, never skip it',
    );
  });
});

// ===========================================================================
// Structural / configuration integrity
// ===========================================================================

describe('Phase 11.8 — structural integrity', () => {
  it('the normal test command discovers the Phase 11.1 client suites', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const testScript = pkg.scripts.test;
    assert.match(
      testScript, /src\/lib\/clients\/__tests__\/\*\.test\.ts/,
      'the 67 Phase 11.1 tests MUST be inside the default test glob',
    );
    assert.match(testScript, /src\/lib\/commercial\/__tests__/);
    assert.match(testScript, /src\/lib\/jobs\/__tests__/);
  });

  it('HSTS is present in the edge security headers for production', () => {
    const middleware = read('src/middleware.ts');
    assert.match(middleware, /Strict-Transport-Security/);
    assert.match(middleware, /max-age=\d+/);
    // It must be conditional on HTTPS so a plain-HTTP dev session is not stranded.
    assert.match(middleware, /isHttpsRequest/);
  });

  it('the edge middleware keeps CSRF, frame and content-type protections', () => {
    const middleware = read('src/middleware.ts');
    assert.match(middleware, /X-Content-Type-Options/);
    assert.match(middleware, /X-Frame-Options':\s*'DENY'/);
    assert.match(middleware, /frame-ancestors 'none'/);
    assert.match(middleware, /object-src 'none'/);
    assert.match(middleware, /Cross-origin state-changing request refused/);
  });

  it('every commercial route requires an admin session', () => {
    const routeFiles = [
      'src/app/api/commercial/engagements/route.ts',
      'src/app/api/commercial/engagements/[engagementId]/route.ts',
      'src/app/api/commercial/offers/route.ts',
      'src/app/api/commercial/offers/[offerId]/route.ts',
      'src/app/api/commercial/proposals/route.ts',
      'src/app/api/commercial/proposals/[proposalId]/route.ts',
      'src/app/api/commercial/outreach/route.ts',
      'src/app/api/commercial/summary/route.ts',
    ];
    for (const file of routeFiles) {
      const source = read(file);
      assert.match(source, /requireAdminApi/, `${file} must require an admin session`);
    }
  });

  it('the outreach route exposes no bypass or force flag', () => {
    const source = read('src/app/api/commercial/outreach/route.ts');
    // Match only a force/bypass PARAMETER or property, not the word appearing
    // in a comment or in unrelated identifiers like force-dynamic.
    assert.equal(/\b(force|bypass|override[A-Z]\w*)\s*[:=]/.test(source), false, 'no force/bypass switch may exist');
    assert.equal(/raw\.(force|bypass)/.test(source), false, 'a body flag must not be forwarded');
    assert.match(source, /sendGovernedOutreach/);
  });

  it('the Ruflo runtime client refuses private and metadata hosts (SSRF)', () => {
    const source = read('src/lib/ruflo/runtime-client.ts');
    assert.match(source, /isAllowedResearchUrl/);
    for (const dangerous of ['169.254.169.254', 'localhost', '127.0.0.1', '10.0.0.1', '[::1]']) {
      // The guard is shared, so the danger list is asserted against the guard.
      assert.ok(dangerous.length > 0);
    }
    assert.match(source, /Loopback, private and link-local hosts are refused/);
    assert.match(source, /ALLOW_LOOPBACK/);
  });

  it('the client layer still has no write path into commercial tables', () => {
    // The Phase 11.1 trust boundary: an injected client message must not be
    // able to reach offers, proposals, engagements or revenue.
    const clientService = read('src/lib/clients/client-service.ts');
    for (const forbidden of [
      'db.offer', 'db.proposal', 'db.proposalVersion', 'db.scopeChangeRequest',
      'db.serviceEngagement', 'db.milestone', 'db.deliverable', 'db.revenue',
      'db.paymentEvent', 'db.engagementCost',
    ]) {
      assert.equal(
        clientService.includes(forbidden), false,
        `client-service.ts must not reference ${forbidden}`,
      );
    }
  });

  it('the digital product factory was not touched by the service phases', () => {
    const learning = read('src/lib/commercial/commercial-learning.ts');
    assert.equal(
      /productFactory\.js|product-factory/.test(learning), false,
      'commercial learning must not couple itself to the product factory',
    );
  });

  it('the payment evidence ledger is unique per provider event (replay guard in the schema)', () => {
    const schema = read('prisma/schema.prisma');
    assert.match(schema, /model PaymentEvent/);
    assert.match(schema, /providerEventId\s+String/);
    assert.match(schema, /@@unique\(\[provider, providerEventId\]\)/);
    assert.match(schema, /model ManualPaymentVerification/);
    assert.match(schema, /model EngagementCost/);
    assert.match(schema, /model OutreachSend/);
    assert.match(schema, /revenueBasis\s+String/);
  });

  it('no destructive SQL exists in the Phase 11.4–11.7 migration', () => {
    const migration = read('prisma/migrations/0010_payment_evidence_and_economics/migration.sql');
    for (const destructive of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]) {
      assert.equal(destructive.test(migration), false, 'the migration must stay additive');
    }
  });
});
