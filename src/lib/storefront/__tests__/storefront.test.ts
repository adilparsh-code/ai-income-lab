// ============================================================================
// STOREFRONT (first-revenue slice) — focused tests.
// ============================================================================
// Three layers:
//   1. eligibility gate  — fail-closed public listing rules (pure);
//   2. inquiry validation — bounded untrusted-input contract (pure);
//   3. structure/security — the storefront really is PUBLIC, the console is
//      still server-gated, and the intake route keeps its abuse protections.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { isPubliclyListableOffer, publicListingVerdict } from '../eligibility';
import { validateStoreInquiry, MAX_STORE_INQUIRY_MESSAGE } from '../inquiry';

const baseOffer = {
  id: 'off_1',
  type: 'DIGITAL_PRODUCT',
  title: 'Notion Productivity Planner',
  description: 'A structured planner template for planning weekly work.',
  scopeSummary: 'One-time template download.',
  price: 19,
  currency: 'USD',
  status: 'ACTIVE',
  halalStatus: 'HALAL',
};

describe('storefront eligibility gate (public listing)', () => {
  it('lists a clean ACTIVE + HALAL + priced offer', () => {
    const verdict = publicListingVerdict(baseOffer);
    assert.equal(verdict.listable, true);
    assert.deepEqual(verdict.reasons, []);
    assert.equal(isPubliclyListableOffer(baseOffer), true);
  });

  it('never lists offers that are not ACTIVE', () => {
    for (const status of ['DRAFT', 'REVIEW_REQUIRED', 'RETIRED', 'BLOCKED', '', 'PUBLISHED']) {
      const verdict = publicListingVerdict({ ...baseOffer, status });
      assert.equal(verdict.listable, false, `status ${status} must not be listed`);
      assert.ok(verdict.reasons.some((r) => r.includes('ACTIVE')));
    }
  });

  it('never lists offers without a positive finite price', () => {
    for (const price of [0, -5, Number.NaN, Infinity, '19' as unknown as number]) {
      const verdict = publicListingVerdict({ ...baseOffer, price });
      assert.equal(verdict.listable, false, `price ${String(price)} must not be listed`);
    }
  });

  it('never lists offers whose stored halalStatus is not HALAL', () => {
    for (const halalStatus of ['UNVERIFIED', 'REVIEW_REQUIRED', 'BLOCKED', '', 'HALAL_REVIEWED']) {
      const verdict = publicListingVerdict({ ...baseOffer, halalStatus });
      assert.equal(verdict.listable, false, `halalStatus ${halalStatus} must not be listed`);
      assert.ok(verdict.reasons.some((r) => r.includes('Halal status')));
    }
  });

  it('re-screens text at display time: prohibited keywords block even a stored-HALAL offer', () => {
    const verdict = publicListingVerdict({
      ...baseOffer,
      title: 'Casino bankroll management ebook',
      description: 'Learn betting progression systems.',
    });
    assert.equal(verdict.listable, false);
    assert.ok(verdict.reasons.some((r) => r.startsWith('Screening blocks')));
  });

  it('re-screens text at display time: review-required keywords drop the offer fail-closed', () => {
    const verdict = publicListingVerdict({
      ...baseOffer,
      description: 'A course about interest-based loan comparisons for students.',
    });
    assert.equal(verdict.listable, false);
    assert.ok(verdict.reasons.some((r) => r.includes('human review')));
  });

  it('collects every blocker instead of short-circuiting', () => {
    const verdict = publicListingVerdict({ id: '', title: '', status: 'DRAFT', price: 0, halalStatus: 'UNVERIFIED' });
    assert.equal(verdict.listable, false);
    assert.ok(verdict.reasons.length >= 4, `expected all reasons, got: ${verdict.reasons.join(' | ')}`);
  });

  it('never throws on malformed input and stays unlistable', () => {
    for (const junk of [{}, { id: 1, title: null, price: 'x' }, null as unknown as object]) {
      const verdict = publicListingVerdict(junk as Parameters<typeof publicListingVerdict>[0]);
      assert.equal(verdict.listable, false);
    }
  });
});

describe('storefront inquiry validation (untrusted input)', () => {
  const valid = {
    offerId: 'off_1',
    displayName: '  Amina Yusuf  ',
    email: '  Buyer@Example.COM ',
    message: 'I would like to buy this, please confirm payment steps.',
    requestId: 'req_abc123_XY',
    company: '',
  };

  it('accepts and normalizes a valid request', () => {
    const result = validateStoreInquiry(valid);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.displayName, 'Amina Yusuf');
    assert.equal(result.value.email, 'buyer@example.com');
    assert.equal(result.value.offerId, 'off_1');
    assert.equal(result.value.honeypot, '');
  });

  it('detects a filled honeypot while keeping the request structurally valid', () => {
    const result = validateStoreInquiry({ ...valid, company: 'Definitely A Bot Ltd' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.honeypot, 'Definitely A Bot Ltd');
  });

  it('rejects non-object bodies', () => {
    for (const junk of [null, 'hello', 42, ['array']]) {
      assert.equal(validateStoreInquiry(junk).ok, false);
    }
  });

  it('requires offerId, name, email, message and requestId', () => {
    const missing: Array<Record<string, unknown>> = [
      { offerId: '' },
      { displayName: '   ' },
      { email: 'not-an-email' },
      { email: 'a@b' },
      { message: '' },
      { requestId: 'short' },
      { requestId: 'has spaces and symbols!' },
    ];
    for (const patch of missing) {
      const result = validateStoreInquiry({ ...valid, ...patch });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    }
  });

  it('bounds name and message length', () => {
    assert.equal(validateStoreInquiry({ ...valid, displayName: 'x'.repeat(201) }).ok, false);
    assert.equal(validateStoreInquiry({ ...valid, message: 'x'.repeat(MAX_STORE_INQUIRY_MESSAGE + 1) }).ok, false);
    assert.equal(validateStoreInquiry({ ...valid, message: 'x'.repeat(MAX_STORE_INQUIRY_MESSAGE) }).ok, true);
  });

  it('rejects control characters instead of stripping them', () => {
    const result = validateStoreInquiry({ ...valid, displayName: 'Amina\u0000Yusuf' });
    assert.equal(result.ok, false);
  });
});

describe('storefront structure and security invariants', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('the public storefront lives OUTSIDE the gated (admin) group', () => {
    // Public pages exist in their own route group…
    assert.equal(existsSync('src/app/(storefront)/store/page.tsx'), true);
    assert.equal(existsSync('src/app/(storefront)/store/[offerId]/page.tsx'), true);
    // …and the public layout itself performs no admin session check.
    assert.equal(read('src/app/(storefront)/layout.tsx').includes('currentAdminSession'), false);
    // The operator console view IS gated; no public store page sits in (admin).
    const gated = readdirSync('src/app/(admin)');
    assert.equal(gated.includes('storefront'), true);
    assert.equal(gated.includes('store'), false);
  });

  it('root layout renders no admin console chrome; the (admin) layout keeps the gate + shell', () => {
    const root = read('src/app/layout.tsx');
    assert.equal(root.includes('<Sidebar'), false, 'public routes must not inherit admin navigation');
    assert.equal(root.includes('lg:ml-64'), false, 'public routes must not inherit the console offset');

    const admin = read('src/app/(admin)/layout.tsx');
    assert.match(admin, /currentAdminSession/);
    assert.match(admin, /AdminLoginGate/);
    assert.match(admin, /force-dynamic/);
    assert.match(admin, /<Sidebar/);
    assert.match(admin, /session \? children : <AdminLoginGate/);
  });

  it('the inquiry intake keeps its abuse protections and stays admin-free by design', () => {
    const route = read('src/app/api/store/inquiries/route.ts');
    assert.match(route, /enforceRateLimit/);
    assert.match(route, /readJsonBody/);
    assert.match(route, /requireSameOriginIfBrowser/);
    assert.match(route, /validateStoreInquiry/);
    assert.match(route, /recordStoreInquiry/);
    // It must not become an operator endpoint or mint sessions.
    assert.equal(route.includes('requireAdminApi'), false);
    assert.equal(route.includes('cookie'), false);
    assert.equal(route.includes('setCookie'), false);
  });

  it('the storefront queries funnel every offer through the fail-closed eligibility gate', () => {
    const store = read('src/lib/storefront/store.ts');
    assert.match(store, /publicListingVerdict/);
    assert.equal(/status: 'ACTIVE', halalStatus: 'HALAL', price: \{ gt: 0 \}/.test(store), true);
    // Inbound leads are recorded through the EXISTING client pipeline only.
    assert.match(store, /createProspect/);
    assert.match(store, /recordClientMessage/);
    assert.match(store, /source: 'INBOUND'/);
    assert.equal(store.includes('revenue.create'), false, 'storefront must never write the revenue ledger');
    assert.equal(store.includes('paymentState'), false, 'storefront must never touch payment state');
  });
});
