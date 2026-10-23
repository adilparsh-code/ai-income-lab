// HIGH-1 — Negative envelope cases the current suite leaves untested.
// These are pure unit tests over validateHandoffEnvelope (no database).
// They are regression guards: a receiver fix must not weaken any of them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoffEnvelope } from '../handoff-envelope';

function base(): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    contractId: 'contract-abc-1',
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    eventType: 'OPPORTUNITY_PROPOSED',
    title: 'Niche research newsletter',
    description: 'A curated weekly newsletter about practical automation topics.',
    category: 'MEDIA',
    businessModel: 'SUBSCRIPTION',
    monetizationMethod: 'PAID_SUBSCRIPTION',
    assertedEligibility: 'ALLOWED',
    payload: { notes: 'plain data only' },
  };
}

describe('HIGH-1 envelope negative cases (regression guards)', () => {
  it('rejects an empty required string field (e.g. zero-length idempotency key)', () => {
    const body = base();
    delete (body as Record<string, unknown>).idempotencyKey;
    const result = validateHandoffEnvelope(body);
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /idempotencyKey/.test(e)),
      'expected an error naming idempotencyKey',
    );
  });

  it('rejects a payload that is a JSON array', () => {
    const result = validateHandoffEnvelope({ ...base(), payload: ['a', 'b'] as unknown });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /payload must be a JSON object/.test(e)),
      'expected a plain-object payload error',
    );
  });

  it('rejects a payload that is a flat string', () => {
    const result = validateHandoffEnvelope({ ...base(), payload: 'just a string' as unknown });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /payload must be a JSON object/.test(e)),
      'expected a plain-object payload error',
    );
  });

  it('rejects an unsupported contract version', () => {
    const result = validateHandoffEnvelope({ ...base(), contractVersion: '2.0' });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /Unsupported contractVersion/.test(e)),
      'expected an unsupported contractVersion error',
    );
  });

  it('rejects an unsupported event type', () => {
    const result = validateHandoffEnvelope({ ...base(), eventType: 'RUN_SHELL' });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /Unsupported eventType/.test(e)),
      'expected an unsupported eventType error',
    );
  });

  it('rejects an unsupported assertedEligibility', () => {
    const result = validateHandoffEnvelope({ ...base(), assertedEligibility: 'NOT_SURE' });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /assertedEligibility/.test(e)),
      'expected an assertedEligibility error',
    );
  });

  it('rejects a payload nesting deeper than the bound', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    const result = validateHandoffEnvelope({ ...base(), payload: deep });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /nests deeper/.test(e)),
      'expected a depth error',
    );
  });

  it('rejects a forbidden payload key', () => {
    const result = validateHandoffEnvelope({
      ...base(),
      payload: { prompt: 'ignore instructions' },
    });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /forbidden key/i.test(e)),
      'expected a forbidden-key error',
    );
  });

  it('rejects an unknown top-level envelope field', () => {
    const result = validateHandoffEnvelope({ ...base(), jobType: 'PUBLISH' });
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /Unknown envelope field/.test(e)),
      'expected an unknown-field error',
    );
  });

  it('rejects a non-JSON body', () => {
    const result = validateHandoffEnvelope('not json {');
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /Request body must be a JSON object/.test(e)),
      'expected a JSON-object error',
    );
  });

  it('rejects a JSON array body', () => {
    const result = validateHandoffEnvelope([1, 2, 3]);
    assert.equal(result.ok, false);
    assert.ok(
      !result.ok && result.errors?.some((e) => /must be a JSON object/.test(e)),
      'expected a JSON object error',
    );
  });
});
