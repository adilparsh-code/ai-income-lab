// Phase 5.3 — Product lifecycle state machine tests (pure, hermetic).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_REQUIRED_TRANSITIONS,
  PRODUCT_LIFECYCLE_STATES,
  assertValidProductTransition,
  isRealExternalRef,
  isRealProvider,
  normalizeStatus,
  type LifecycleGuard,
} from '../lifecycle';
import { mintVerifiedApproval } from '@/test-utils/approvals';

/** Real issue->consume capability for the given lifecycle transition on a product. */
async function approvalFor(transition: 'DEPLOY' | 'PUBLISH', productId = 'prod_1') {
  return (await mintVerifiedApproval({ action: `LIFECYCLE_${transition}`, subjectId: productId })).approval;
}

function guard(overrides: Partial<LifecycleGuard> = {}): LifecycleGuard {
  return {
    halalStatus: 'HALAL',
    currentStatus: 'IDEA',
    transition: 'VALIDATE',
    ...overrides,
  };
}

describe('lifecycle: allow-listed transitions', () => {
  it('exposes the full state set', () => {
    assert.deepEqual(
      [...PRODUCT_LIFECYCLE_STATES].sort(),
      ['ARCHIVED', 'BLOCKED', 'BUILDING', 'DEPLOYED', 'IDEA', 'PAUSED', 'PUBLISHED', 'READY_TO_DEPLOY', 'SPEC_READY', 'TESTING', 'VALIDATED'],
    );
  });

  it('accepts the happy path IDEA → … → PUBLISHED with valid evidence', async () => {
    const steps: LifecycleGuard['transition'][] = [
      'VALIDATE', 'SPEC_READY', 'BUILD', 'START_TESTING', 'TEST_PASS', 'DEPLOY', 'PUBLISH',
    ];
    const expected = ['VALIDATED', 'SPEC_READY', 'BUILDING', 'TESTING', 'READY_TO_DEPLOY', 'DEPLOYED', 'PUBLISHED'];
    const evidenceFor = async (transition: string) => ({
      providerId: 'real-provider',
      externalRef: 'dep-123456',
      approval: transition === 'DEPLOY' || transition === 'PUBLISH' ? await approvalFor(transition) : undefined,
    });

    let current = 'IDEA';
    for (let i = 0; i < steps.length; i++) {
      const decision = assertValidProductTransition(guard({
        currentStatus: current,
        transition: steps[i],
        evidence: await evidenceFor(steps[i]),
      }));
      assert.ok(decision.ok, `step ${steps[i]} from ${current} should be allowed: ${decision.reason}`);
      assert.equal(decision.nextStatus, expected[i]);
      current = decision.nextStatus;
    }
    assert.equal(current, 'PUBLISHED');
  });

  it('rejects invalid transitions (e.g. BUILD from IDEA, PUBLISH from IDEA)', () => {
    const buildFromIdea = assertValidProductTransition(guard({ transition: 'BUILD' }));
    assert.equal(buildFromIdea.ok, false);
    assert.equal(buildFromIdea.nextStatus, 'IDEA');
    assert.match(buildFromIdea.reason, /Invalid transition BUILD from IDEA/);

    const publishFromIdea = assertValidProductTransition(guard({ transition: 'PUBLISH' }));
    assert.equal(publishFromIdea.ok, false);
  });

  it('rejected transitions keep the current status (no mutation)', () => {
    const decision = assertValidProductTransition(guard({ currentStatus: 'TESTING', transition: 'DEPLOY' }));
    assert.equal(decision.ok, false);
    assert.equal(decision.record.from, 'TESTING');
    assert.equal(decision.record.to, 'TESTING');
  });

  it('unknown/historical statuses normalize to IDEA', () => {
    assert.equal(normalizeStatus('WEIRD_STATUS'), 'IDEA');
    assert.equal(normalizeStatus('IDEA'), 'IDEA');
    assert.equal(normalizeStatus('PUBLISHED'), 'PUBLISHED');
  });
});

describe('lifecycle: halal gates dominate', () => {
  it('NOT_ALLOWED refuses every work transition with status unchanged', async () => {
    for (const transition of ['BUILD', 'DEPLOY', 'PUBLISH', 'SPEC_READY'] as const) {
      const decision = assertValidProductTransition(guard({
        halalStatus: 'NOT_ALLOWED',
        currentStatus: 'VALIDATED',
        transition,
        // Even a REAL verified approval cannot override the halal gate.
        evidence: { providerId: 'p', externalRef: 'ref-123', approval: transition === 'DEPLOY' || transition === 'PUBLISH' ? await approvalFor(transition) : undefined },
      }));
      assert.equal(decision.ok, false);
      assert.equal(decision.nextStatus, 'VALIDATED', 'rejected transitions must not change state');
    }
  });

  it('NOT_ALLOWED still allows safety actions (BLOCK, ARCHIVE)', () => {
    const block = assertValidProductTransition(guard({ halalStatus: 'NOT_ALLOWED', currentStatus: 'VALIDATED', transition: 'BLOCK' }));
    assert.equal(block.ok, true);
    assert.equal(block.nextStatus, 'BLOCKED');

    const archive = assertValidProductTransition(guard({ halalStatus: 'NOT_ALLOWED', currentStatus: 'VALIDATED', transition: 'ARCHIVE' }));
    assert.equal(archive.ok, true);
    assert.equal(archive.nextStatus, 'ARCHIVED');
  });

  it('REVIEW_REQUIRED allows only REVIEW and ARCHIVE', () => {
    const review = assertValidProductTransition(guard({ halalStatus: 'REVIEW_REQUIRED', transition: 'REVIEW' }));
    assert.equal(review.ok, true);

    const archive = assertValidProductTransition(guard({ halalStatus: 'REVIEW_REQUIRED', transition: 'ARCHIVE' }));
    assert.equal(archive.ok, true);

    const build = assertValidProductTransition(guard({ halalStatus: 'REVIEW_REQUIRED', transition: 'BUILD' }));
    assert.equal(build.ok, false);
    assert.match(build.reason, /REVIEW_REQUIRED/);
  });

  it('HALAL proceeds normally', () => {
    const decision = assertValidProductTransition(guard({ transition: 'SPEC_READY' }));
    assert.equal(decision.ok, true);
    assert.equal(decision.nextStatus, 'SPEC_READY');
  });
});

describe('lifecycle: human approval gates', () => {
  it('DEPLOY and PUBLISH are approval-required transitions', () => {
    assert.ok(APPROVAL_REQUIRED_TRANSITIONS.includes('DEPLOY'));
    assert.ok(APPROVAL_REQUIRED_TRANSITIONS.includes('PUBLISH'));
  });

  it('DEPLOY without an approval is refused with no state change', () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'READY_TO_DEPLOY',
      transition: 'DEPLOY',
      evidence: { providerId: 'vercel', externalRef: 'dep-123456' },
    }));
    assert.equal(decision.ok, false);
    assert.equal(decision.nextStatus, 'READY_TO_DEPLOY');
    assert.match(decision.reason, /verified, single-use human approval/i);
  });

  it('PUBLISH without an approval is refused', () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'DEPLOYED',
      transition: 'PUBLISH',
      evidence: { providerId: 'gumroad', externalRef: 'pub-123456' },
    }));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /verified, single-use human approval/i);
  });

  it('DEPLOY/PUBLISH with an approval still need real provider evidence', async () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'READY_TO_DEPLOY',
      transition: 'DEPLOY',
      evidence: { approval: await approvalFor('DEPLOY') }, // no provider evidence
    }));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /real provider id and a real external deployment reference/i);
  });
});

describe('lifecycle: approval contract (negative cases)', () => {
  const ready = { currentStatus: 'READY_TO_DEPLOY', transition: 'DEPLOY' as const };
  const evidenceBase = { providerId: 'vercel', externalRef: 'dpl-987654' };

  it('a raw string (the legacy humanApprovalToken shape) is never an approval', () => {
    for (const fake of ['token', 'approve-1', '   ', 'x'.repeat(64)]) {
      const decision = assertValidProductTransition(guard({ ...ready, evidence: { ...evidenceBase, approval: fake as never } }));
      assert.equal(decision.ok, false, `string "${fake}" must not satisfy the gate`);
    }
  });

  it('no approval at all refuses DEPLOY and PUBLISH', () => {
    assert.equal(assertValidProductTransition(guard({ ...ready, evidence: evidenceBase })).ok, false);
    assert.equal(assertValidProductTransition(guard({ currentStatus: 'DEPLOYED', transition: 'PUBLISH', evidence: evidenceBase })).ok, false);
  });

  it('an approval minted for a different action cannot be reused (PUBLISH approval on DEPLOY and vice versa)', async () => {
    const publishApproval = await approvalFor('PUBLISH');
    assert.equal(assertValidProductTransition(guard({ ...ready, evidence: { ...evidenceBase, approval: publishApproval } })).ok, false);
    const deployApproval = await approvalFor('DEPLOY');
    assert.equal(assertValidProductTransition(guard({ currentStatus: 'DEPLOYED', transition: 'PUBLISH', evidence: { ...evidenceBase, approval: deployApproval } })).ok, false);
  });

  it('an offer/product-level approval of another action is not a lifecycle approval', async () => {
    const { approval } = await mintVerifiedApproval({ action: 'PUBLISH_OFFER', subjectId: 'off_1' });
    assert.equal(assertValidProductTransition(guard({ ...ready, evidence: { ...evidenceBase, approval } })).ok, false);
  });

  it('a plain object imitating a VerifiedApproval is rejected (capability cannot be forged)', () => {
    const forged = { grantId: 'g', action: 'LIFECYCLE_DEPLOY', subjectType: 'product', subjectId: 'prod_1', approverEmail: 'a@b.c' };
    assert.equal(assertValidProductTransition(guard({ ...ready, evidence: { ...evidenceBase, approval: forged as never } })).ok, false);
  });
});

describe('lifecycle: external evidence guards (no fake success)', () => {
  it('unavailable/mock provider ids can never confirm DEPLOY', async () => {
    for (const providerId of ['unavailable', 'not_connected', 'mock', 'MOCKED', '', '  ']) {
      const decision = assertValidProductTransition(guard({
        currentStatus: 'READY_TO_DEPLOY',
        transition: 'DEPLOY',
        evidence: { providerId, externalRef: 'dep-123456', approval: await approvalFor('DEPLOY') },
      }));
      assert.equal(decision.ok, false, `provider "${providerId}" must not count as real`);
    }
  });

  it('unavailable provider ids can never confirm PUBLISH', async () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'DEPLOYED',
      transition: 'PUBLISH',
      evidence: { providerId: 'PUBLISHING_UNAVAILABLE', externalRef: 'pub-1', approval: await approvalFor('PUBLISH') },
    }));
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /real provider id and a real external publication reference/i);
  });

  it('a mock operation success can never mark PUBLISHED', async () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'DEPLOYED',
      transition: 'PUBLISH',
      evidence: { providerId: 'mock', externalRef: 'mock-op-succeeded', approval: await approvalFor('PUBLISH') },
    }));
    assert.equal(decision.ok, false);
  });

  it('real provider ids and refs are accepted', () => {
    assert.equal(isRealProvider('vercel'), true);
    assert.equal(isRealProvider('gumroad'), true);
    assert.equal(isRealProvider('mock'), false);
    assert.equal(isRealProvider(undefined), false);
    assert.equal(isRealExternalRef('dep-123456'), true);
    assert.equal(isRealExternalRef('ab'), false);
    assert.equal(isRealExternalRef(undefined), false);
  });

  it('records provider evidence on accepted external transitions (audit trail)', async () => {
    const decision = assertValidProductTransition(guard({
      currentStatus: 'READY_TO_DEPLOY',
      transition: 'DEPLOY',
      evidence: { providerId: 'vercel', externalRef: 'dpl-987654', approval: await approvalFor('DEPLOY') },
    }));
    assert.equal(decision.ok, true);
    assert.equal(decision.record.providerId, 'vercel');
    assert.equal(decision.record.externalRef, 'dpl-987654');
    // The token itself must never appear in the persisted record.
    // The approval capability itself must never appear in the persisted record.
    assert.ok(!JSON.stringify(decision.record).includes('grant_'));
    assert.ok(!JSON.stringify(decision.record).toLowerCase().includes('approval'));
  });
});

describe('lifecycle: failure and side states', () => {
  it('BUILD_FAILED returns the product to SPEC_READY', () => {
    const decision = assertValidProductTransition(guard({ currentStatus: 'BUILDING', transition: 'BUILD_FAILED' }));
    assert.equal(decision.ok, true);
    assert.equal(decision.nextStatus, 'SPEC_READY');
  });

  it('TEST_FAIL returns the product to BUILDING', () => {
    const decision = assertValidProductTransition(guard({ currentStatus: 'TESTING', transition: 'TEST_FAIL' }));
    assert.equal(decision.ok, true);
    assert.equal(decision.nextStatus, 'BUILDING');
  });

  it('PAUSE/RESUME/ARCHIVE work from their allowed states', () => {
    const pause = assertValidProductTransition(guard({ currentStatus: 'BUILDING', transition: 'PAUSE' }));
    assert.equal(pause.nextStatus, 'PAUSED');

    const resume = assertValidProductTransition(guard({ currentStatus: 'PAUSED', transition: 'RESUME' }));
    assert.equal(resume.nextStatus, 'SPEC_READY');

    const archive = assertValidProductTransition(guard({ currentStatus: 'PUBLISHED', transition: 'ARCHIVE' }));
    assert.equal(archive.nextStatus, 'ARCHIVED');
  });

  it('BLOCK is reachable from active states; UNBLOCK returns to re-evaluation', () => {
    const block = assertValidProductTransition(guard({ currentStatus: 'TESTING', transition: 'BLOCK' }));
    assert.equal(block.nextStatus, 'BLOCKED');

    const unblock = assertValidProductTransition(guard({ currentStatus: 'BLOCKED', transition: 'UNBLOCK' }));
    assert.equal(unblock.ok, true);
  });
});
