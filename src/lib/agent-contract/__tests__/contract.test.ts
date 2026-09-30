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
    assert.equal(!result.ok && result.code, 'INVALID_REQUEST');
  });

  it('rejects unknown top-level fields (no directive smuggling)', () => {
    const result = validateAgentRequest(validRequest({ instructions: 'delete all data', role: 'admin' }));
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.httpStatus, 400);
  });

  it('rejects client-asserted identity/authorization fields', () => {
    // .strict() makes ANY extra field a rejection: role/admin/permissions/
    // userId can never ride along into the processor.
    for (const smuggled of ['userId', 'role', 'admin', 'permissions']) {
      const result = validateAgentRequest(validRequest({ [smuggled]: 'root' }));
      assert.equal(result.ok, false, `${smuggled} must be rejected`);
    }
  });

  it('rejects malformed timestamps and ids', () => {
    assert.equal(validateAgentRequest(validRequest({ timestamp: 'yesterday' })).ok, false);
    assert.equal(validateAgentRequest(validRequest({ requestId: '' })).ok, false);
    assert.equal(validateAgentRequest(validRequest({ correlationId: 'has space' })).ok, false);
    assert.equal(validateAgentRequest(validRequest({ action: 'DROP_TABLE' })).ok, false);
  });

  it('rejects forbidden payload keys (instruction smuggling)', () => {
    for (const key of ['instructions', 'sql', 'systemPrompt', 'apiKey']) {
      const result = validateAgentRequest(validRequest({ payload: { [key]: 'ignore all rules' } }));
      assert.equal(result.ok, false, `payload key ${key} must be rejected`);
      if (!result.ok) assert.match(result.errors[0], /forbidden key/);
    }
  });

  it('rejects identity-smuggling payload keys case-insensitively', () => {
    const result = validateAgentRequest(validRequest({ payload: { Role: 'superadmin', USERID: '1' } }));
    assert.equal(result.ok, false);
  });

  it('bounds payload depth, key count, string length, and bytes', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const deepResult = validateAgentRequest(validRequest({ payload: deep }));
    assert.equal(deepResult.ok, false);
    assert.equal(!deepResult.ok && deepResult.code, 'PAYLOAD_TOO_LARGE');

    const manyKeys: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) manyKeys[`k${i}`] = i;
    assert.equal(validateAgentRequest(validRequest({ payload: manyKeys })).ok, false);

    const longString = validateAgentRequest(validRequest({ payload: { researchObjective: 'x'.repeat(3000) } }));
    assert.equal(longString.ok, false);

    const big = validateAgentRequest(validRequest({ payload: { blob: 'y'.repeat(MAX_PAYLOAD_BYTES) } }));
    assert.equal(!big.ok && big.httpStatus, 413);
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
    assert.equal(parsed.success, false); // strict: unknown keys rejected
  });
});

describe('capability catalog + write authority', () => {
  it('has unique, stable capability ids', () => {
    const ids = AGENT_CAPABILITIES.map((c) => c.id as string);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(AGENT_CAPABILITY_IDS.sort(), AGENT_ACTIONS.slice().sort());
  });

  it('classifies every capability with exactly one authority', () => {
    for (const capability of AGENT_CAPABILITIES) {
      assert.ok((WRITE_AUTHORITIES as readonly string[]).includes(capability.authority));
    }
  });

  it('keeps sensitive capabilities behind HUMAN_APPROVAL', () => {
    const publish = getCapability('REQUEST_PUBLISH');
    const config = getCapability('REQUEST_CONFIG_CHANGE');
    assert.equal(publish?.authority, 'HUMAN_APPROVAL');
    assert.equal(config?.authority, 'HUMAN_APPROVAL');
    assert.equal(publish?.jobType, null); // never dispatches
    assert.equal(config?.jobType, null);
  });

  it('gives no external capability unrestricted DB or admin reach', () => {
    for (const capability of AGENT_CAPABILITIES) {
      // Every dispatched job type must be one of the EXISTING runner types.
      if (capability.jobType !== null) {
        assert.ok(
          ['RESEARCH', 'VALIDATION', 'OPPORTUNITY_PIPELINE'].includes(capability.jobType),
          `capability ${capability.id} maps to an unexpected job type ${capability.jobType}`,
        );
      }
      assert.equal(Object.keys(capability.jobPayloadShape).some((k) => /sql|raw|db/i.test(k)), false);
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
