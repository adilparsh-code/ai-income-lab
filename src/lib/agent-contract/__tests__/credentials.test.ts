// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — credential auth + audit/redaction tests
// ============================================================================
// Hermetic (no DB). Covers: NOT_CONFIGURED fail-closed, valid/invalid/expired
// presentation, grant binding, fingerprinting (never the token), audit record
// shape, duplicate race handling, and secret redaction.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  authenticateAgentRequest,
  discoverAgentCredentials,
} from '../credentials';
import {
  redactSecrets,
  recordAgentAction,
  attachJobToAgentAction,
  type AgentActionDb,
  type AgentActionRow,
} from '../audit';

const ENV = {
  AGENT_ALPHA_TOKEN: 'alpha-secret-token-value',
  AGENT_ALPHA_ID: 'alpha-agent',
  AGENT_ALPHA_CAPABILITIES: 'READ_OPPORTUNITY,WRITE_RESEARCH_EVIDENCE',
  AGENT_BETA_TOKEN: 'beta-secret-token-value',
  AGENT_BETA_ID: 'beta-agent',
  // beta has NO capabilities env → empty grant (fails closed on writes)
};

describe('agent credential discovery', () => {
  it('discovers configured bindings and ignores malformed ones', () => {
    const configs = discoverAgentCredentials({
      AGENT_ALPHA_TOKEN: 'tok',
      AGENT_ALPHA_ID: 'alpha',
      AGENT_ALPHA_CAPABILITIES: 'READ_OPPORTUNITY',
      AGENT_NO_ID_TOKEN: 'tok2', // no _ID → ignored
      AGENT_EMPTY_TOKEN: '', // empty → ignored
      AGENT_lower_token: 'tok3', // invalid label shape → ignored
      OPERATOR_CONTROL_TOKEN: 'unrelated', // never treated as an agent binding
    });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].label, 'ALPHA');
    assert.equal(configs[0].agentId, 'alpha');
  });

  it('reports NOT_CONFIGURED when no binding exists', () => {
    assert.equal(discoverAgentCredentials({}).length, 0);
  });
});

describe('agent request authentication', () => {
  it('fails closed with 503 when nothing is configured', () => {
    const verdict = authenticateAgentRequest('Bearer anything', {});
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.status, 503);
    assert.equal(!verdict.ok && verdict.configured, false);
  });

  it('authenticates a valid credential and derives identity server-side', () => {
    const verdict = authenticateAgentRequest(`Bearer ${ENV.AGENT_ALPHA_TOKEN}`, ENV);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.identity.agentId, 'alpha-agent');
      assert.equal(verdict.identity.credentialLabel, 'ALPHA');
      assert.deepEqual(verdict.identity.grantedCapabilities, ['READ_OPPORTUNITY', 'WRITE_RESEARCH_EVIDENCE']);
      // The fingerprint is retained; the token is NOT anywhere in the verdict.
      assert.equal(verdict.identity.fingerprint.length, 16);
      assert.equal(JSON.stringify(verdict).includes(ENV.AGENT_ALPHA_TOKEN), false);
    }
  });

  it('rejects a wrong token (401) and a missing header (401)', () => {
    const wrong = authenticateAgentRequest('Bearer not-the-token', ENV);
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.status, 401);
    const missing = authenticateAgentRequest(null, ENV);
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.status, 401);
  });

  it('rejects a token from a rotated-away credential (revocation)', () => {
    // Rotation = the operator changes AGENT_ALPHA_TOKEN; the old presentation
    // no longer matches any binding → 401.
    const rotated = { ...ENV, AGENT_ALPHA_TOKEN: 'new-rotated-token-value' };
    const verdict = authenticateAgentRequest(`Bearer ${ENV.AGENT_ALPHA_TOKEN}`, rotated);
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.status, 401);
  });

  it('binds an empty grant to a credential that has no capabilities env', () => {
    const verdict = authenticateAgentRequest(`Bearer ${ENV.AGENT_BETA_TOKEN}`, ENV);
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.deepEqual(verdict.identity.grantedCapabilities, []);
      // And that credential can authorize nothing:
      const authz = authorizeCapability('READ_OPPORTUNITY', verdict.identity.grantedCapabilities);
      assert.equal(authz.allowed, false);
    }
  });

  function authorizeCapability(action: string, granted: string[]): { allowed: boolean } {
    // Local import indirection keeps this describe focused on auth shape.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { authorizeCapability: authz } = require('../capabilities') as typeof import('../capabilities');
    return authz(action as never, granted as never);
  }
});

// ---------------------------------------------------------------------------
// Audit + redaction
// ---------------------------------------------------------------------------

function makeFakeStore() {
  const rows = new Map<string, AgentActionRow>();
  let seq = 1;
  const store: AgentActionDb = {
    agentActionRecord: {
      async findUnique({ where }) {
        return rows.get(where.requestId) ?? null;
      },
      async create({ data }) {
        if (rows.has(data.requestId)) throw new Error('Unique constraint failed: requestId');
        const row: AgentActionRow = {
          id: `row-${seq++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.set(data.requestId, row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.get(where.requestId);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { store, rows };
}

describe('audit records + secret redaction', () => {
  it('redacts secret-shaped keys at any depth', () => {
    const redacted = redactSecrets({
      apiKey: 'sk-live-123',
      nested: { Authorization: 'Bearer xyz', safe: 'value' },
      list: [{ password: 'hunter2' }],
      token: 'tok',
    }) as Record<string, unknown>;
    assert.equal(redacted.apiKey, '[REDACTED]');
    assert.equal((redacted.nested as Record<string, unknown>).Authorization, '[REDACTED]');
    assert.equal((redacted.nested as Record<string, unknown>).safe, 'value');
    assert.equal((redacted.list as Record<string, unknown>[])[0].password, '[REDACTED]');
    assert.equal(redacted.token, '[REDACTED]');
  });

  it('bounds reason strings and never persists credential material', async () => {
    const fake = makeFakeStore();
    const outcome = await recordAgentAction(
      {
        agentId: 'alpha-agent',
        agentVersion: '1.0',
        action: 'WRITE_RESEARCH_EVIDENCE',
        requestId: 'req-a1',
        correlationId: 'corr-a1',
        authorizationResult: 'ALLOWED',
        safetyVerdict: 'HALAL',
        status: 'ACCEPTED',
        result: { jobCorrelation: 'agent:alpha-agent:corr-a1', Authorization: `Bearer ${ENV.AGENT_ALPHA_TOKEN}` },
        reason: `accepted with Bearer ${ENV.AGENT_ALPHA_TOKEN}`, // hostile-caller simulation
        agentFingerprint: 'fp-0000000000000000',
      },
      fake.store,
    );
    assert.equal(outcome.ok, true);
    const row = fake.rows.get('req-a1');
    assert.ok(row);
    assert.equal(row?.status, 'ACCEPTED');
    assert.equal(row?.agentFingerprint, 'fp-0000000000000000');
    // The token must not appear anywhere in the row: Bearer material is
    // scrubbed from reasons and secret-shaped keys are redacted from results.
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes(ENV.AGENT_ALPHA_TOKEN), false);
    assert.match(row?.reason ?? '', /accepted with Bearer \[REDACTED\]/);
    const parsedResult = JSON.parse(row?.resultJson ?? '{}') as Record<string, unknown>;
    assert.equal(parsedResult.Authorization, '[REDACTED]');
  });

  it('is race-safe on the unique requestId (returns the winner)', async () => {
    const fake = makeFakeStore();
    const base = {
      agentId: 'alpha-agent',
      agentVersion: '1.0',
      action: 'READ_OPPORTUNITY',
      correlationId: 'corr-r1',
      authorizationResult: 'ALLOWED' as const,
      safetyVerdict: 'NOT_APPLICABLE' as const,
      agentFingerprint: 'fp-1',
    };
    const first = await recordAgentAction({ ...base, requestId: 'req-race', status: 'ACCEPTED', reason: 'first' }, fake.store);
    const second = await recordAgentAction({ ...base, requestId: 'req-race', status: 'REJECTED', reason: 'second' }, fake.store);
    assert.equal(first.ok && !first.raced, true);
    assert.equal(second.ok && second.raced, true);
    assert.equal(fake.rows.get('req-race')?.reason, 'first');
  });

  it('attaches jobId/reviewId without breaking on missing rows', async () => {
    const fake = makeFakeStore();
    await recordAgentAction(
      {
        agentId: 'a', agentVersion: '1', action: 'READ_OPPORTUNITY',
        requestId: 'req-j1', correlationId: 'corr-j1',
        authorizationResult: 'ALLOWED', safetyVerdict: 'NOT_APPLICABLE',
        status: 'ACCEPTED', agentFingerprint: 'fp',
      },
      fake.store,
    );
    await attachJobToAgentAction('req-j1', { jobId: 'job-9' }, fake.store);
    assert.equal(fake.rows.get('req-j1')?.jobId, 'job-9');
    // Unknown row → silent no-op (never throws).
    await attachJobToAgentAction('req-missing', { jobId: 'job-x' }, fake.store);
  });
});
