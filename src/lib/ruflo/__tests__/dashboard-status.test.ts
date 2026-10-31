// Ruflo dashboard status mapping: a registered handle must never be shown as
// connected. Pure tests — no database or Prisma client needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeRufloDashboardStatus } from '../dashboard-status';

const ALL_RUNTIME_STATUSES = ['NOT_CONFIGURED', 'AUTH_REQUIRED', 'CONNECTING', 'CONNECTED', 'ERROR'] as const;

describe('ruflo dashboard status mapping', () => {
  it('shows a connected label ONLY for verified CONNECTED', () => {
    for (const status of ALL_RUNTIME_STATUSES) {
      const view = describeRufloDashboardStatus(status);
      const looksConnected = /^RUFLO CONNECTED/.test(view.label);
      assert.equal(looksConnected, status === 'CONNECTED', `${status} -> "${view.label}"`);
      assert.equal(view.healthVerified, status === 'CONNECTED', `${status} healthVerified`);
    }
  });

  it('a registered but unverified handle (CONNECTING) is not labelled connected', () => {
    const view = describeRufloDashboardStatus('CONNECTING');
    assert.equal(view.state, 'CONNECTING');
    assert.equal(view.label, 'HANDLE REGISTERED · NOT VERIFIED');
    assert.equal(view.healthVerified, false);
    assert.equal(view.tone, 'warn');
    assert.doesNotMatch(view.label, /CONNECTED/);
  });

  it('a stale health check is shown via CONNECTING: amber, not verified, never green/connected', () => {
    // describeRufloRuntime() returns CONNECTING for a success older than the
    // 10-minute window; the mapping must therefore never render it as connected.
    const view = describeRufloDashboardStatus('CONNECTING');
    assert.equal(view.tone, 'warn');
    assert.equal(view.healthVerified, false);
    assert.match(view.note, /stale|within the last 10 minutes/);
  });

  it('keeps the existing default wording when nothing is configured', () => {
    const view = describeRufloDashboardStatus('NOT_CONFIGURED');
    assert.equal(view.label, 'RUFLO READY · NOT CONNECTED');
    assert.equal(view.tone, 'muted');
  });

  it('distinguishes a missing handle (not a claim about the cause) and failed verification', () => {
    const auth = describeRufloDashboardStatus('AUTH_REQUIRED');
    assert.equal(auth.label, 'TOKEN SET · NO HANDLE REGISTERED');
    assert.doesNotMatch(auth.label, /ENABLED|DISABLED/);
    assert.equal(describeRufloDashboardStatus('ERROR').label, 'RUFLO HEALTH CHECK FAILED');
    assert.equal(describeRufloDashboardStatus('ERROR').healthVerified, false);
  });

  it('maps unknown, missing or legacy capability strings to UNAVAILABLE, never connected', () => {
    for (const input of [null, undefined, '', 'RUFLO_CONNECTED', 'RUFLO_READY', 'connected', 'LIVE']) {
      const view = describeRufloDashboardStatus(input as string | null | undefined);
      assert.equal(view.state, 'UNAVAILABLE', String(input));
      assert.equal(view.healthVerified, false);
      assert.doesNotMatch(view.label, /^RUFLO CONNECTED/);
    }
  });

  it('every state has a label, a tone and a non-empty explanation', () => {
    for (const status of [...ALL_RUNTIME_STATUSES, null] as const) {
      const view = describeRufloDashboardStatus(status);
      assert.ok(view.label.length > 0);
      assert.ok(['good', 'warn', 'muted'].includes(view.tone));
      assert.ok(view.note.length > 20);
    }
  });
});
