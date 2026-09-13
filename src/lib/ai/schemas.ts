// Server-only structured-output validation (Phase 4.2.1 foundation).
// Dependency-free: JSON parsing + required-field + basic type checks.
// Provider output validated here must still ALWAYS be classified AI_INFERENCE
// by callers — validation proves shape, never truth.

import type { AiJsonSchema } from './provider';

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | 'object'
  | 'object[]';

export interface SchemaValidationSuccess {
  valid: true;
  value: Record<string, unknown>;
}

export interface SchemaValidationFailure {
  valid: false;
  errors: string[];
}

export type SchemaValidationResult = SchemaValidationSuccess | SchemaValidationFailure;

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkFieldType(field: string, expected: SchemaFieldType, value: unknown): string | null {
  switch (expected) {
    case 'string':
      return typeof value === 'string' ? null : `field "${field}" must be a string (got ${describeType(value)})`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `field "${field}" must be a finite number (got ${describeType(value)})`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `field "${field}" must be a boolean (got ${describeType(value)})`;
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : `field "${field}" must be an array of strings (got ${describeType(value)})`;
    case 'number[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'number' && Number.isFinite(v))
        ? null
        : `field "${field}" must be an array of finite numbers (got ${describeType(value)})`;
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : `field "${field}" must be an object (got ${describeType(value)})`;
    case 'object[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
        ? null
        : `field "${field}" must be an array of objects (got ${describeType(value)})`;
    default:
      return `field "${field}" has an unsupported expected type`;
  }
}

/** Parse raw model text as JSON. Never throws — returns a typed failure. */
export function parseJsonDocument(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'Model output is empty; expected a JSON document.' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'Model output is not valid JSON.' };
  }
}

/**
 * Validate a parsed value against a schema. Returns the narrowed record on
 * success; callers must still treat the content as AI_INFERENCE.
 */
export function validateAgainstSchema(value: unknown, schema: AiJsonSchema): SchemaValidationResult {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, errors: ['Model output must be a JSON object.'] };
  }
  const record = value as Record<string, unknown>;
  for (const field of schema.required ?? []) {
    if (!(field in record) || record[field] === undefined || record[field] === null) {
      errors.push(`missing required field "${field}"`);
    }
  }
  for (const [field, expected] of Object.entries(schema.properties ?? {})) {
    if (!(field in record) || record[field] === undefined || record[field] === null) continue;
    const problem = checkFieldType(field, expected, record[field]);
    if (problem) errors.push(problem);
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: record };
}

/** Parse + validate in one step for the generate() orchestration layer. */
export function parseAndValidate(text: string, schema: AiJsonSchema): SchemaValidationResult {
  const parsed = parseJsonDocument(text);
  if (!parsed.ok) return { valid: false, errors: [parsed.error] };
  return validateAgainstSchema(parsed.value, schema);
}
