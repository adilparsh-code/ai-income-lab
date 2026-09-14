// Phase 4.2.1 - Structured output validation tests
// Verifies: JSON parsing works, malformed JSON fails safely,
// required-field validation works, wrong property type fails safely.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonDocument, validateAgainstSchema, parseAndValidate } from '../schemas';
import type { AiJsonSchema } from '../provider';

describe('AI Schema Validation (Phase 4.2.1)', () => {
  describe('parseJsonDocument', () => {
    it('parses valid JSON object', () => {
      const result = parseJsonDocument('{"key": "value"}');
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.value, { key: 'value' });
    });

    it('parses valid JSON array', () => {
      const result = parseJsonDocument('[1, 2, 3]');
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.value, [1, 2, 3]);
    });

    it('fails on malformed JSON (truncated)', () => {
      const result = parseJsonDocument('{"key": "value"');
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /not valid JSON/i);
    });

    it('fails on plain text (not JSON)', () => {
      const result = parseJsonDocument('hello world');
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /not valid JSON/i);
    });

    it('fails on empty string', () => {
      const result = parseJsonDocument('');
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /empty/i);
    });

    it('fails on whitespace-only string', () => {
      const result = parseJsonDocument('   ');
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error, /empty/i);
    });
  });

  describe('validateAgainstSchema', () => {
    const schema: AiJsonSchema = {
      required: ['name', 'score'],
      properties: {
        name: 'string',
        score: 'number',
        active: 'boolean',
        tags: 'string[]',
        counts: 'number[]',
      },
    };

    it('validates a complete valid object', () => {
      const value = { name: 'test', score: 85, tags: ['a', 'b'] };
      const result = validateAgainstSchema(value, schema);
      assert.equal(result.valid, true);
    });

    it('passes with required fields only', () => {
      const result = validateAgainstSchema({ name: 'test', score: 50 }, schema);
      assert.equal(result.valid, true);
    });

    it('fails when a required field is missing', () => {
      const result = validateAgainstSchema({ name: 'test' }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /missing required field "score"/.test(e)));
    });

    it('fails when a required field is null', () => {
      const result = validateAgainstSchema({ name: 'test', score: null }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /missing required field "score"/.test(e)));
    });

    it('empty string is a present field (structural validation, not semantic)', () => {
      // validateAgainstSchema checks structure (null/undefined/missing), not
      // semantic emptiness. An empty string is a valid string value.
      const result = validateAgainstSchema({ name: '', score: 50 }, schema);
      assert.equal(result.valid, true);
    });

    it('rejects wrong type: number where string expected', () => {
      const result = validateAgainstSchema({ name: 123, score: 50 }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /must be a string/.test(e)));
    });

    it('rejects wrong type: string where number expected', () => {
      const result = validateAgainstSchema({ name: 'test', score: 'high' }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /must be a finite number/.test(e)));
    });

    it('rejects wrong type: string where boolean expected', () => {
      const result = validateAgainstSchema({ name: 'test', score: 50, active: 'yes' }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /must be a boolean/.test(e)));
    });

    it('rejects wrong type: array with non-string elements where string[] expected', () => {
      const result = validateAgainstSchema({ name: 'test', score: 50, tags: ['a', 123] }, schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /array of strings/.test(e)));
    });

    it('rejects array as top-level value', () => {
      const result = validateAgainstSchema([1, 2, 3], schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /must be a JSON object/.test(e)));
    });
  });

  describe('parseAndValidate', () => {
    const schema: AiJsonSchema = { required: ['name'], properties: { name: 'string' } };

    it('parses and validates valid JSON successfully', () => {
      const result = parseAndValidate('{"name": "hello"}', schema);
      assert.equal(result.valid, true);
      if (result.valid) assert.equal(result.value.name, 'hello');
    });

    it('fails on malformed JSON', () => {
      const result = parseAndValidate('{broken', schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /not valid JSON/.test(e)));
    });

    it('fails on missing required field after parsing', () => {
      const result = parseAndValidate('{"score": 50}', schema);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some(e => /missing required field "name"/.test(e)));
    });
  });
});

