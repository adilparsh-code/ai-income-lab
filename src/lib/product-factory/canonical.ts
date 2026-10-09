// Phase B1 — Deterministic canonicalization + canonical hash for product
// specifications. Reuses the project's existing SHA-256 convention
// (`createHash('sha256')` in src/lib/product-factory/sandboxed-builder.ts and
// src/lib/integrations/*) so identity math is consistent across the factory.
//
// Rules enforced by construction:
//  - No timestamps, random ids, database ids, or volatile metadata are included
//    in the canonical representation. The canonical form is purely logical: the
//    requested product specification fields that define WHAT should be generated.
//  - Key ordering never affects the hash: the canonicalizer normalizes objects to
//    a stable sorted-key representation before hashing.
//  - Equivalent logical specifications MUST produce the same canonical
//    representation and the same canonical hash.
//
// IMPORTANT: this module is PURE. No DB, no network, no AI, no React. It can be
// imported by server code and by tests without any runtime surface.

import { createHash } from 'node:crypto';

/** SHA-256 hex digest. Same primitive used elsewhere in the factory. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical value serialization
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for a value.
 *
 * Deterministic rules:
 *  - Plain objects are serialized with KEYS SORTED BY NAME (recursively), so
 *    logically equal maps hash identically regardless of insertion order.
 *  - Arrays preserve order (array order is semantically meaningful in this
 *    domain: feature lists, build phases, etc.).
 *  - Primitives use JSON semantics (strings, numbers, booleans, null).
 *  - Unsupported types (Date, Map, Set, functions, circular refs) throw
 *    during canonicalization so the caller cannot accidentally canonize
 *    volatile state.
 */
export function toCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), orderedStringifyReplacer);
}

/** Canonicalize a value without serializing (for inspection / assertions). */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not canonicalizable.');
    return value;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    if (!isPlainRecord(value)) {
      throw new Error('Unsupported canonical value type: only plain JSON objects are supported.');
    }
    return recordToSortedEntries(value);
  }

  throw new Error(`Unsupported canonical value type: ${typeof value}`);
}

/** Coerce an unknown (possibly already-parsed) value into a canonical record,
 *  rejecting non-plain objects (Date, RegExp, class instances, etc.). */
export function asCanonicalRecord(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new Error('Canonical records must be plain JSON objects.');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k, canonicalize(v)])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return Object.fromEntries(entries) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stable sorted-key object representation
// ---------------------------------------------------------------------------

/** Plain JSON object, not a Date/RegExp/class instance. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Return a new object with keys in ascending lexical order, normalized from a
 *  source record whose values are already canonicalized. */
function recordToSortedEntries(record: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}

/** JSON.stringify replacer that emits sorted-key objects.
 *
 *  JSON.stringify visits object keys in insertion order. By replacing each
 *  object with a new sorted-key object AT serialization time, we guarantee that
 *  the resulting JSON text is byte-for-byte stable for logically equal inputs
 *  regardless of how the source objects were constructed.
 *
 *  Arrays are NOT re-keyed (their order is semantically meaningful), but each
 *  array element is canonicalized via the recursive object handling path.
 */
function orderedStringifyReplacer(
  _key: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(orderValue);
  }
  if (typeof value === 'object') {
    return orderValue(value);
  }
  throw new Error(`Unsupported JSON value type: ${typeof value}`);
}

/** Normalize one value for deterministic serialization. */
function orderValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(orderValue);
  }
  if (typeof value === 'object') {
    if (!isPlainRecord(value)) {
      throw new Error('Only plain JSON objects are canonicalizable.');
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = orderValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  throw new Error(`Unsupported value type: ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Canonical identity for a product specification
// ---------------------------------------------------------------------------

/** Fields that define WHAT a product specification requests. These are the only
 *  fields folded into the canonical identity. Volatile request metadata (who
 *  asked, when, correlation id, database id, attempt index) is deliberately
 *  excluded. */
export type SpecificationCanonicalField =
  | 'productType'
  | 'name'
  | 'targetAudience'
  | 'problem'
  | 'valueProposition'
  | 'mvpFeatures'
  | 'buildPhases'
  | 'monetizationModel'
  | 'pricingHypothesis'
  | 'distributionChannels'
  | 'risks'
  | 'assumptions'
  | 'evidence'
  | 'evidenceProvenance'
  | 'solution'
  | 'userFlows'
  | 'techRequirements'
  | 'acceptanceCriteria';

/** The ordered list of canonical fields. Order here is fixed and documented; it
 *  determines the field order in the canonical representation (array order of
 *  top-level keys), which is stable and human-auditable. */
export const SPEC_CANONICAL_FIELD_ORDER: SpecificationCanonicalField[] = [
  'acceptanceCriteria',
  'assumptions',
  'buildPhases',
  'distributionChannels',
  'evidence',
  'evidenceProvenance',
  'mvpFeatures',
  'monetizationModel',
  'name',
  'problem',
  'productType',
  'pricingHypothesis',
  'risks',
  'solution',
  'techRequirements',
  'targetAudience',
  'userFlows',
  'valueProposition',
] as const;

/** Canonical representation of a product specification.
 *
 *  A plain JSON object whose top-level keys appear in the fixed order defined by
 *  `SPEC_CANONICAL_FIELD_ORDER`, and whose nested objects are recursively
 *  sorted-key normalized. This is the stable representation that is hashed to
 *  produce the canonical identity. */
export type CanonicalSpecification = Record<string, unknown>;

/** Build the canonical representation of a product specification from the
 *  canonical field set.
 *
 *  Only the fields enumerated in `SPEC_CANONICAL_FIELD_ORDER` are included; any
 *  additional keys on the source object (e.g. transient request metadata) are
 *  ignored. Omitted fields are emitted as `null` so the canonical form is
 *  structurally stable across calls. */
export function canonicalSpecificationOf(
  source: Record<string, unknown>,
): CanonicalSpecification {
  const record: Record<string, unknown> = {};
  for (const field of SPEC_CANONICAL_FIELD_ORDER) {
    const raw = source[field];
    if (raw === undefined || raw === null) {
      record[field] = null;
      continue;
    }
    record[field] = canonicalize(raw);
  }
  return record;
}

/** Deterministic canonical hash for a product specification.
 *
 *  Equivalent logical specifications produce:
 *    same canonical representation
 *        ↓
 *    same canonical hash
 *
 *  The hash is SHA-256 over the canonical JSON text produced by
 *  `canonicalSpecificationOf`. It does NOT include timestamps, random ids,
 *  database ids, or any volatile request metadata, and key ordering cannot
 *  affect it. */
export function canonicalHashOf(source: Record<string, unknown>): string {
  const canonical = canonicalSpecificationOf(source);
  return sha256Hex(toCanonicalJson(canonical));
}
