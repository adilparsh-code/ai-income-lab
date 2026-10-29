// Single-use approval ledger — pure tests over an in-memory store that runs the
// REAL issue/consume/peek logic (no fabricated capabilities).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_TTL_MS,
  VerifiedApproval,
  approvalCovers,
  approvalScopeHash,
  consumeApproval,
  isVerifiedApproval,
  issueApproval,
  peekApproval,
  type ApprovalStore,
} from '@/lib/security/approvals-core';
import { InMemoryApprovalStore } from '@/test-utils/approvals';

const approver = { sessionId: 'test-admin-session', email: 'admin@test.local' };
const scope = { id: 'off_1', price: 29 };
const scopeHash = approvalScopeHash(scope);

async function issue(store: InMemoryApprovalStore, over: Partial<Parameters<typeof issueApproval>[0]> = {}) {
  return issueApproval({ action: 'PUBLISH_OFFER', subjectId: 'off_1', scopeHash, approver, ...over }, store);
}
const expectFor = { action: 'PUBLISH_OFFER' as const, subjectId: 'off_1', scopeHash, surface: 'test' };

describe('approval ledger', () => {
  it('issues an opaque token and stores ONLY its hash', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    assert.ok(token.length >= 43);
    assert.equal(JSON.stringify(store.rows).includes(token), false);
    assert.match(store.rows[0].tokenHash, /^[0-9a-f]{64}$/);
  });

  it('consume succeeds once and yields a frozen capability bound to action/subject', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    const first = await consumeApproval(token, expectFor, store);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(isVerifiedApproval(first.approval));
    assert.ok(Object.isFrozen(first.approval));
    assert.equal(approvalCovers(first.approval, { action: 'PUBLISH_OFFER', subjectId: 'off_1' }), true);
    assert.equal(approvalCovers(first.approval, { action: 'PUBLISH_OFFER', subjectId: 'off_2' }), false);
    assert.equal(approvalCovers(first.approval, { action: 'DEPLOY_PRODUCT', subjectId: 'off_1' }), false);
  });

  it('REPLAY is refused (single use)', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    assert.equal((await consumeApproval(token, expectFor, store)).ok, true);
    const replay = await consumeApproval(token, expectFor, store);
    assert.deepEqual(replay, { ok: false, reason: 'CONSUMED' });
  });

  it('CONCURRENT consumers: exactly one wins', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeApproval(token, expectFor, store)));
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  it('refuses a different subject, action or scope (MISMATCH) and does NOT burn the grant', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    for (const bad of [
      { ...expectFor, subjectId: 'off_2' },
      { ...expectFor, action: 'PUBLISH_PRODUCT' as const },
      { ...expectFor, scopeHash: approvalScopeHash({ id: 'off_1', price: 1 }) },
    ]) {
      const r = await consumeApproval(token, bad, store);
      assert.deepEqual(r, { ok: false, reason: 'MISMATCH' });
    }
    assert.equal((await consumeApproval(token, expectFor, store)).ok, true);
  });

  it('refuses expired grants', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store, { now: new Date(Date.now() - APPROVAL_TTL_MS - 1000) });
    assert.deepEqual(await consumeApproval(token, expectFor, store), { ok: false, reason: 'EXPIRED' });
  });

  it('refuses when the approver admin session has ended', async () => {
    const store = new InMemoryApprovalStore();
    store.liveSessions.add('s2');
    const { token } = await issue(store, { approver: { sessionId: 's2', email: 'a@b.c' } });
    store.liveSessions.delete('s2');
    assert.deepEqual(await consumeApproval(token, expectFor, store), { ok: false, reason: 'APPROVER_SESSION_ENDED' });
  });

  it('refuses missing, malformed, unknown and string-shaped legacy tokens', async () => {
    const store = new InMemoryApprovalStore();
    await issue(store);
    for (const bad of [undefined, null, '', '   ', 'token', 'approve-1', 'x'.repeat(10), 'x'.repeat(600), 'has space in it but long enough to pass length check', {}, 42]) {
      const r = await consumeApproval(bad, expectFor, store);
      assert.equal(r.ok, false);
    }
    assert.equal((await consumeApproval('A'.repeat(43), expectFor, store)).ok, false); // well-formed but unknown
  });

  it('fails CLOSED when the store errors', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    const broken: ApprovalStore = { ...store, create: store.create.bind(store), find: async () => { throw new Error('db down'); }, consume: store.consume.bind(store), sessionLive: store.sessionLive.bind(store) };
    assert.deepEqual(await consumeApproval(token, expectFor, broken), { ok: false, reason: 'STORE_ERROR' });
    assert.equal(await peekApproval(token, expectFor, broken), false);
  });

  it('peek never consumes and never authorizes', async () => {
    const store = new InMemoryApprovalStore();
    const { token } = await issue(store);
    assert.equal(await peekApproval(token, expectFor, store), true);
    assert.equal(await peekApproval(token, expectFor, store), true);
    assert.equal(store.rows[0].consumedAt, null);
    assert.equal(await peekApproval(token, { ...expectFor, subjectId: 'zzz' }, store), false);
  });

  it('a VerifiedApproval cannot be constructed outside consumeApproval()', () => {
    assert.throws(() => new VerifiedApproval(Symbol('x'), { grantId: 'g', action: 'PUBLISH_OFFER', subjectType: 'offer', subjectId: 'off_1', approverEmail: 'a@b.c' }));
    const lookalike = { grantId: 'g', action: 'PUBLISH_OFFER', subjectType: 'offer', subjectId: 'off_1', approverEmail: 'a@b.c' };
    assert.equal(isVerifiedApproval(lookalike), false);
    assert.equal(approvalCovers(lookalike, { action: 'PUBLISH_OFFER', subjectId: 'off_1' }), false);
  });

  it('issuing validates action, subject and approver', async () => {
    const store = new InMemoryApprovalStore();
    await assert.rejects(issue(store, { action: 'NOPE' as never }));
    await assert.rejects(issue(store, { subjectId: '' }));
    await assert.rejects(issue(store, { subjectId: 'x'.repeat(129) }));
    await assert.rejects(issue(store, { approver: { sessionId: '', email: 'a@b.c' } }));
  });
});
