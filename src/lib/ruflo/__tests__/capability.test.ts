// Phase 5.4 — Ruflo capability discovery tests: the boundary must report
// honestly that Ruflo is RUFLO_READY at contract level but NOT_CONNECTED.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeRufloIntegration } from '../capability';
import { describeWorkflowBoundary } from '../workflow-runner';

describe('ruflo capability discovery', () => {
  it('reports NOT_CONNECTED when no Ruflo runtime exists', () => {
    const status = describeRufloIntegration();
    // No Ruflo package/credential exists in this repository — the honest
    // answer is NOT_CONNECTED, never a fake connection.
    assert.equal(status.status, 'NOT_CONNECTED');
    assert.match(status.detail, /NOT_CONNECTED/);
  });

  it('lists unmet requirements', () => {
    const status = describeRufloIntegration();
    // Phase 5.5: a real integration means a registered orchestrator handle —
    // exactly one honest requirement; no invented credential items.
    assert.equal(status.unmetRequirements.length, 1);
    assert.ok(status.unmetRequirements[0].toLowerCase().includes('register'));
    assert.ok(/handle/i.test(status.unmetRequirements[0]));
  });

  it('exposes the workflow contracts Ruflo would orchestrate through', () => {
    const status = describeRufloIntegration();
    assert.ok(status.availableContracts.length >= 2);
    const boundary = describeWorkflowBoundary();
    assert.equal(boundary.status, 'RUFLO_READY');
    assert.ok(status.availableContracts.some((c) => c.includes('runJob')));
  });

  it('documents the invariants that survive a future connection', () => {
    const status = describeRufloIntegration();
    const joined = status.invariantsPreserved.join(' ');
    for (const term of ['idempotency', 'Halal', 'retries', 'cost']) {
      assert.ok(joined.toLowerCase().includes(term.toLowerCase()), `missing invariant: ${term}`);
    }
  });
});
