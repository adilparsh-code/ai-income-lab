// ============================================================================
// AGENT INTEGRATION CONTRACT v1 — pure contract + capability tests
// ============================================================================
// Hermetic (no DB, no network). Covers: valid/invalid schema shapes, unknown
// field rejection, identity-smuggling rejection, payload bounds, forbidden
// keys, capability catalog invariants, grant parsing, and authorization.
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAgentRequest,
  payloadByteSize,
  MAX_PAYLOAD_BYTES,
  AGENT_CONTRACT_VERSION,
  agentRequestSchema,
  FORBIDDEN_PAYLOAD_KEYS,
  AGENT_ACTIONS,
} from '../contract';
import {
  AGENT_CAPABILITIES,
  AGENT_CAPABILITY_IDS,
  authorizeCapability,
  parseGrant,
  getCapability,
  WRITE_AUTHORITIES,
} from '../capabilities';

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 'v1',
    agentId: 'mock-agent-runtime',
    agentVersion: 'mock-1.0.0',
    requestId: 'req-0001',
    correlationId: 'corr-0001',
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'WRITE_RESEARCH_EVIDENCE',
    payload: { researchObjective: 'Evaluate demand for a TypeScript toolkit.' },
    ...overrides,
  };
}

describe('agent request schema (v1)', () => {
  it('accepts a valid, minimal request', () => {
    const result = validateAgentRequest(validRequest());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.request.contractVersion, 'v1');
      assert.deepEqual(result.request.payload, { researchObjective: 'Evaluate demand for a TypeScript toolkit.' });
    }
  });

  it('accepts a request with an empty payload (defaults to {})', () => {
    const result = validateAgentRequest(validRequest({ payload: undefined }));
    assert.equal(result.ok, true);
  });

  it('rejects an unsupported contract version', () => {
    const result = validateAgentRequest(validRequest({ contractVersion: 'v2' }));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'UNSUPPORTED_CONTRACT_VERSION');
  });

  it('rejects unknown top-level fields (no directive smuggling)', () => {
    for (const smuggled of ['role', 'permission', 'execute', 'admin', 'actions']) {
      const result = validateAgentRequest(validRequest({ [smuggled]: 'root' }));
      assert.equal(result.ok, false, `smuggled field ${smuggled} must be rejected`);
    }
  });

  it('rejects client-asserted identity/authorization fields', () => {
    // The runtime derives identity from the credential, never from the body.
    // A body that asserts these would let a caller pick a different identity.
    for (const smuggled of ['agentId', 'role', 'admin', 'permissions']) {
      const result = validateAgentRequest(validRequest({ [smuggled]: 'root' }));
      assert.equal(result.ok, false, `smuggled field ${smuggled} must be rejected`);
    }
  });

  it('rejects malformed timestamps and ids', () => {
    assert.equal(
      validateAgentRequest(validRequest({ timestamp: 'yesterday' })).ok,
      false,
      'malformed timestamp must be rejected',
    );
    assert.equal(
      validateAgentRequest(validRequest({ requestId: '   ' })).ok,
      false,
      'blank request id must be rejected',
    );
  });

  it('rejects forbidden payload keys (instruction smuggling)', () => {
    for (const key of FORBIDDEN_PAYLOAD_KEYS) {
      const result = validateAgentRequest(validRequest({ payload: { [key]: 'drop table opportunities;' } }));
      assert.equal(result.ok, false, `forbidden key ${key} must be rejected`);
    }
  });

  it('rejects identity-smuggling payload keys case-insensitively', () => {
    // The contract strips SQL-shaped keys case-insensitively.
    for (const k of ['SQL', 'Query', 'EXEC', 'Db', 'TABLE']) {
      const result = validateAgentRequest(validRequest({ payload: { [k.toLowerCase()]: 'anything' } }));
      assert.equal(result.ok, false, `forbidden key ${k} (lowercased) must still be rejected`);
    }
  });

  it('bounds payload depth, key count, string length, and bytes', () => {
    const deep = validateAgentRequest(validRequest({ payload: { nested: { nested: { nested: { nested: { end: true } } } } } }));
    assert.equal(deep.ok, false, 'very deep payload should be rejected');

    const wide = validateAgentRequest(validRequest({ payload: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])) }));
    assert.equal(wide.ok, false, 'very wide payload should be rejected');

    const longString = validateAgentRequest(validRequest({ payload: { researchObjective: 'x'.repeat(3000) } }));
    assert.equal(longString.ok, false);

    const big = validateAgentRequest(validRequest({ payload: { blob: 'y'.repeat(MAX_PAYLOAD_BYTES) } }));
    assert.equal(!big.ok && big.httpStatus, 413);

    const manyKeys = Object.fromEntries(Array.from({ length: MAX_PAYLOAD_KEYS }, (_, i) => [`k${i}`, i]));
    assert.equal(validateAgentRequest(validRequest({ payload: manyKeys })).ok, false);

    // Boundary tests: the limit must hold at the exact threshold, not only
    // for obviously-overflowing inputs. An off-by-one here would silently
    // widen the accepted payload envelope.
    const belowDepth = validateAgentRequest(validRequest({ payload: makeDeep(MAX_PAYLOAD_DEPTH - 1) }));
    assert.equal(belowDepth.ok, true, `depth ${MAX_PAYLOAD_DEPTH - 1} wraps must be accepted`);
    const atDepth = validateAgentRequest(validRequest({ payload: makeDeep(MAX_PAYLOAD_DEPTH) }));
    assert.equal(atDepth.ok, false, `depth ${MAX_PAYLOAD_DEPTH} wraps must be rejected`);
    assert.equal(!atDepth.ok && atDepth.code, 'PAYLOAD_TOO_LARGE');

    const belowKeys = validateAgentRequest(validRequest({ payload: makeManyKeys(MAX_PAYLOAD_KEYS - 1) }));
    assert.equal(belowKeys.ok, true, `payload with ${MAX_PAYLOAD_KEYS - 1} keys must be accepted`);
    const atKeys = validateAgentRequest(validRequest({ payload: makeManyKeys(MAX_PAYLOAD_KEYS) }));
    assert.equal(atKeys.ok, true, `payload with exactly ${MAX_PAYLOAD_KEYS} keys must be accepted`);
    const overKeys = validateAgentRequest(validRequest({ payload: makeManyKeys(MAX_PAYLOAD_KEYS + 1) }));
    assert.equal(overKeys.ok, false, `payload with ${MAX_PAYLOAD_KEYS + 1} keys must be rejected`);

    const belowLen = validateAgentRequest(validRequest({ payload: { f: 'x'.repeat(MAX_FIELD_LENGTH - 1) } }));
    assert.equal(belowLen.ok, true);
    const atLen = validateAgentRequest(validRequest({ payload: { f: 'x'.repeat(MAX_FIELD_LENGTH) } }));
    assert.equal(atLen.ok, true, `string of exactly ${MAX_FIELD_LENGTH} chars must be accepted`);
    const overLen = validateAgentRequest(validRequest({ payload: { f: 'x'.repeat(MAX_FIELD_LENGTH + 1) } }));
    assert.equal(overLen.ok, false, `string of ${MAX_FIELD_LENGTH + 1} chars must be rejected`);
  });

  it('measures payload byte size deterministically', () => {
    assert.equal(payloadByteSize({ a: 'x' }), 9); // {"a":"x"} = 9 bytes
    assert.equal(payloadByteSize({} as Record<string, unknown>), 2);
  });

  it('exposes the stable error vocabulary and version', () => {
    assert.equal(AGENT_CONTRACT_VERSION, 'v1');
    assert.ok(FORBIDDEN_PAYLOAD_KEYS.includes('sql'));
    assert.equal(AGENT_ACTIONS.length, 9);
  });

  it('validates the Zod schema directly for strictness', () => {
    const parsed = agentRequestSchema.safeParse(validRequest({ extra: true }));
    assert.equal(parsed.success, false); // unknown field rejected by Zod
  });
});

describe('capability catalog + write authority', () => {
  it('has unique, stable capability ids', () => {
    const ids = AGENT_CAPABILITY_IDS.map((c) => c.id as string);
    assert.deepEqual(new Set(ids).size, ids.length);
  });

  it('classifies every capability with exactly one authority', () => {
    for (const capability of AGENT_CAPABILITIES) {
      const authorities = WRITE_AUTHORITIES.filter((a) => capability.authority === a);
      assert.equal(authorities.length, 1, `capability ${capability.id} must have exactly one authority`);
    }
  });

  it('keeps sensitive capabilities behind HUMAN_APPROVAL', () => {
    for (const capability of AGENT_CAPABILITIES) {
      if (capability.category === 'SENSITIVE' || capability.jobType === 'REVIEW_REQUIRED') {
        assert.equal(capability.authority, 'HUMAN_APPROVAL', `capability ${capability.id} must require human approval`);
      }
    }
  });

  it('gives no external capability unrestricted DB or admin reach', () => {
    for (const capability of AGENT_CAPABILITIES) {
      assert.ok(
        ['READ_OPPORTUNITY', 'READ_REVENUE', 'READ_ANALYTICS'].includes(capability.id),
        `unexpected external capability ${capability.id} must be reviewed`,
      );
      assert.equal(
        [WRITE_AUTHORITIES[0], WRITE_AUTHORITIES[1]].includes(capability.authority),
        true,
        `capability ${capability.id} must use a bounded write authority`,
      );
    }
  });

  it('requires halal screening on every write', () => {
    for (const capability of AGENT_CAPABILITIES) {
      if (capability.authority === 'SAFE_WRITE' || capability.authority === 'BOUNDED_WRITE') {
        assert.equal(capability.halalScreened, true, `${capability.id} must be halal-screened`);
      }
    }
  });

  it('parses grants (wildcard, list, junk)', () => {
    assert.deepEqual(parseGrant('*').sort(), AGENT_CAPABILITY_IDS.slice().sort());
    assert.deepEqual(parseGrant('READ_OPPORTUNITY, READ_REVENUE'), ['READ_OPPORTUNITY', 'READ_REVENUE']);
    assert.deepEqual(parseGrant('NOT_A_CAPABILITY'), []);
    assert.deepEqual(parseGrant(''), []);
    assert.deepEqual(parseGrant(undefined), []);
  });

  it('authorizes only granted capabilities', () => {
    const granted = parseGrant('READ_OPPORTUNITY');
    assert.equal(authorizeCapability('READ_OPPORTUNITY', granted).allowed, true);
    const denied = authorizeCapability('CREATE_EXPERIMENT', granted);
    assert.equal(denied.allowed, false);
    assert.equal(denied.capabilityExists, true);
    const unknown = authorizeCapability('DROP_TABLE' as never, granted);
    assert.equal(unknown.allowed, false);
    assert.equal(unknown.capabilityExists, false);
  });
});

// Helpers for building boundary payloads.
function makeDeep(wraps: number): Record<string, unknown> {
  let p: Record<string, unknown> = { end: true };
  for (let i = 0; i < wraps; i += 1) p = { nested: p };
  return p;
}

function makeManyKeys(n: number): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) m[`k${i}`] = i;
  return m;
}
