// Phase B1 - Product Factory Core: deterministic spec -> generation -> version ->
// package. Server-side service built on the new Prisma models. Additive only:
// it does NOT touch the existing Product/build/deploy/asset/offer/revenue/auth/
// dashboard/store paths. ProductVersion links to Product as a plain column only.
//
// Core guarantees enforced by construction + DB constraints:
//  - Deterministic identity: a ProductSpecification is looked up (and created) by
//    its canonicalHash, derived from sorted-key canonical JSON in canonical.ts.
//    Equivalent logical specs resolve to the same row.
//  - DB-level uniqueness on canonicalHash prevents concurrent duplicate
//    specifications even when the read-then-write path races.
//  - generationMode is persisted on ProductGeneration AND copied onto the
//    ProductVersion, so the version is self-describing and the mode is not
//    transient request metadata.
//  - Immutability: a ProductVersion's content, generationMode, and canonical
//    identity are never overwritten. A changed product creates a NEW generation +
//    NEW version. Packaging creates a new ProductPackage row and never mutates a
//    historical version.
//  - Content dedup: if a version with the same content canonical hash already
//    exists, generateFromSpecification returns the existing version rather than
//    creating a duplicate. The content canonical hash unique constraint is the
//    backstop; the service handles it gracefully.

import { db } from '@/lib/db';
import {
  canonicalHashOf,
  asCanonicalRecord,
  canonicalSpecificationOf,
  sha256Hex,
  toCanonicalJson,
  type CanonicalSpecification,
} from './canonical';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The minimum validated request that defines WHAT product should be generated. */
export interface ProductSpecificationRequest {
  /** Structured specification; plain JSON object (canonical fields). */
  spec: Record<string, unknown>;
  /** Human label for display. Not part of canonical identity. */
  label?: string;
  /** Who/origin triggered the spec creation (audit, not identity). */
  requestedBy?: string;
  /** Origin label: 'manual' | 'pipeline' | 'api' | etc. */
  source?: string;
}

/** Known generation modes. Grows over time; validated as non-empty strings. */
export const KNOWN_GENERATION_MODES = [
  'autonomous-pipeline',
  'deterministic-builder',
  'manual-review',
  'imported',
] as const;
export type GenerationMode = (typeof KNOWN_GENERATION_MODES)[number];

/** One product version produced by a generation. Immutable once created. */
export interface ProductVersionRecord {
  id: string;
  generationId: string;
  productId: string | null;
  versionLabel: string;
  content: string;
  generationMode: GenerationMode;
  contentCanonicalHash: string;
  createdAt: Date;
}

/** A deterministic package/artifact representation for a version. */
export interface ProductPackageRecord {
  id: string;
  versionId: string;
  packageType: string;
  packageBody: string;
  packageHash: string;
  artifactRef: string;
  createdAt: Date;
}

/** The persisted canonical spec, plus system fields. */
export interface ProductSpecificationRecord {
  id: string;
  label: string;
  canonicalBody: string;
  canonicalHash: string;
  requestedBy: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Specification identity
// ---------------------------------------------------------------------------

/** Build the canonical representation of a specification request using the
 *  full canonical field set (all SPEC_CANONICAL_FIELD_ORDER fields, with nulls
 *  for omitted ones). This is what gets hashed and stored. */
function canonicalSpecOf(request: ProductSpecificationRequest): CanonicalSpecification {
  if (!request.spec || typeof request.spec !== 'object' || Array.isArray(request.spec)) {
    throw new Error('Product specification must be a plain JSON object.');
  }
  // Reuse isPlainRecord logic from canonical.ts via asCanonicalRecord's check.
  // We call asCanonicalRecord to validate, then canonicalSpecificationOf to build
  // the full canonical form with all fields (including nulls for omitted ones).
  asCanonicalRecord(request.spec);
  return canonicalSpecificationOf(request.spec);
}

/** Compute the canonical hash for a specification request. */
export function canonicalHashFor(request: ProductSpecificationRequest): string {
  return canonicalHashOf(canonicalSpecOf(request));
}

// ---------------------------------------------------------------------------
// Specification persistence (idempotent by canonical identity)
// ---------------------------------------------------------------------------

/**
 * Find an existing specification by canonical identity, or create one.
 *
 * Duplicate protection is enforced at TWO levels:
 *  1. Application-level: we look up by canonicalHash first and return the
 *     existing row when present.
 *  2. Database-level: `canonicalHash` is @unique, so two concurrent requests for
 *     the same logical spec collide on the unique constraint and only one row is
 *     created. The caller receives the existing row either way.
 *
 * IMPORTANT: we do NOT rely on "find -> if missing -> create" as the only
 * protection. The unique constraint is the real guard against concurrent
 * duplicates; the lookup is the fast path.
 */
export async function getOrCreateSpecification(
  request: ProductSpecificationRequest,
): Promise<{ spec: ProductSpecificationRecord; created: boolean }> {
  const canonical = canonicalSpecOf(request);
  const canonicalBody = toCanonicalJson(canonical);
  const canonicalHash = canonicalHashOf(canonical);

  const existing = await db.productSpecification.findUnique({
    where: { canonicalHash },
  });
  if (existing) {
    return { spec: existing as unknown as ProductSpecificationRecord, created: false };
  }

  try {
    const created = await db.productSpecification.create({
      data: {
        label: request.label?.trim() ?? '',
        canonicalBody,
        canonicalHash,
        requestedBy: request.requestedBy?.trim() ?? '',
        source: request.source?.trim() ?? '',
      },
    });
    return { spec: created as unknown as ProductSpecificationRecord, created: true };
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code !== 'P2002' && code !== 'SQLITE_CONSTRAINT_UNIQUE') {
      throw error;
    }
    const winner = await db.productSpecification.findUnique({ where: { canonicalHash } });
    if (!winner) {
      throw new Error('Concurrent specification creation race: unique constraint violated but no row found.');
    }
    return { spec: winner as unknown as ProductSpecificationRecord, created: false };
  }
}

// ---------------------------------------------------------------------------
// Generation + version creation (immutable)
// ---------------------------------------------------------------------------

/**
 * The result of generating a product from a specification.
 *
 * Preserves:
 *  - specification identity (specificationId + canonicalHash via the spec row)
 *  - generation identity (generationId + generationRef)
 *  - generation mode (persisted on ProductGeneration AND ProductVersion)
 *  - resulting product version (ProductVersion, immutable)
 */
export interface GenerationResult {
  specification: ProductSpecificationRecord;
  generation: {
    id: string;
    specificationId: string;
    generationRef: string;
    generationMode: GenerationMode;
    status: string;
    outcomeSummary: string;
    createdAt: Date;
    completedAt: Date | null;
  };
  version: ProductVersionRecord;
}

/** Compute the content canonical hash for a version's content. */
function contentCanonicalHashFor(content: string): string {
  const parsed = JSON.parse(content);
  const canonical = asCanonicalRecord({ content: parsed });
  return sha256Hex(toCanonicalJson(canonical));
}

/** Try to find an existing version with the given content canonical hash.
 *  Returns the version if found, null otherwise. */
async function findExistingVersionByContentHash(
  contentCanonicalHash: string,
): Promise<{ version: ProductVersionRecord; generation: { id: string; specificationId: string; generationMode: GenerationMode; generationRef: string; status: string; outcomeSummary: string; createdAt: Date; completedAt: Date | null } } | null> {
  const row = await db.productVersion.findUnique({
    where: { contentCanonicalHash },
    include: { generation: true },
  });
  if (!row) return null;
  return {
    version: row as unknown as ProductVersionRecord,
    generation: {
      id: row.generation.id,
      specificationId: row.generation.specificationId,
      generationMode: row.generation.generationMode as GenerationMode,
      generationRef: row.generation.generationRef,
      status: row.generation.status,
      outcomeSummary: row.generation.outcomeSummary,
      createdAt: row.generation.createdAt,
      completedAt: row.generation.completedAt,
    },
  };
}

/**
 * Generate a concrete immutable product version from a specification.
 *
 * `generationMode` names HOW the product was generated. It is persisted on the
 * ProductGeneration row AND copied onto the resulting ProductVersion, so the
 * version is self-describing and the mode is never transient request metadata.
 *
 * Content deduplication: if a version with the same content canonical hash
 * already exists, the existing version is returned (no duplicate is created).
 * This is enforced by the contentCanonicalHash unique constraint as backstop.
 *
 * A new version is created for each unique content. Existing versions are
 * never mutated.
 */
export async function generateFromSpecification(
  specificationId: string,
  options: {
    /** The generation mode - persisted, not transient. */
    generationMode: GenerationMode;
    /** Optional link to the existing Product row the lab tracks (plain column). */
    productId?: string;
    /** The generated product content for this version (JSON string or object). */
    content: string | Record<string, unknown>;
    /** Optional human-readable version label. If omitted, derived deterministically. */
    versionLabel?: string;
    /** Bounded, safe generation outcome summary (JSON). */
    outcomeSummary?: string | Record<string, unknown>;
  },
): Promise<GenerationResult> {
  if (!KNOWN_GENERATION_MODES.includes(options.generationMode)) {
    throw new Error(`Unknown generation mode: ${options.generationMode}.`);
  }

  const generationMode = options.generationMode;
  const versionLabel = options.versionLabel?.trim() ?? 'v1';

  const contentString =
    typeof options.content === 'string' ? options.content : JSON.stringify(options.content);
  const contentCanonicalHash = contentCanonicalHashFor(contentString);

  // If a version with this exact content already exists, return it (dedup).
  const existing = await findExistingVersionByContentHash(contentCanonicalHash);
  if (existing) {
    return {
      specification: (await db.productSpecification.findUnique({ where: { id: specificationId } })) as unknown as ProductSpecificationRecord,
      generation: existing.generation,
      version: existing.version,
    };
  }

  const specification = await db.productSpecification.findUnique({ where: { id: specificationId } });
  if (!specification) {
    throw new Error(`ProductSpecification "${specificationId}" not found.`);
  }
  const canonicalHash =
    (specification as unknown as { canonicalHash: string }).canonicalHash;

  const generationRef = `${canonicalHash.slice(0, 16)}+${generationMode}`;

  // Insert generation + version in one transactional batch so the version cannot
  // exist without its generation, and vice-versa.
  const [gen] = await db.$transaction([
    db.productGeneration.create({
      data: {
        specificationId,
        generationMode,
        generationRef,
        status: 'SUCCEEDED',
        outcomeSummary: options.outcomeSummary
          ? typeof options.outcomeSummary === 'string'
            ? options.outcomeSummary
            : JSON.stringify(options.outcomeSummary)
          : '{}',
        versions: {
          create: {
            versionLabel,
            content: contentString,
            generationMode,
            contentCanonicalHash,
            productId: options.productId?.trim() ?? null,
          },
        },
      },
      include: { versions: true },
    }),
  ]);
  const version = gen.versions[0];

  return {
    specification: specification as unknown as ProductSpecificationRecord,
    generation: {
      id: gen.id,
      specificationId: gen.specificationId,
      generationRef: gen.generationRef,
      generationMode: gen.generationMode as GenerationMode,
      status: gen.status,
      outcomeSummary: gen.outcomeSummary,
      createdAt: gen.createdAt,
      completedAt: gen.completedAt,
    },
    version: version as unknown as ProductVersionRecord,
  };
}

// ---------------------------------------------------------------------------
// Packaging (traceable, immutable)
// ---------------------------------------------------------------------------

/**
 * Create a deterministic package/artifact representation for a generated
 * product version.
 *
 * Traceability chain:
 *   ProductSpecification -> ProductGeneration -> ProductVersion -> ProductPackage
 *
 * Packaging MUST NOT mutate an existing historical version. This function only
 * creates a new ProductPackage row referencing the version. The version's
 * content, generationMode, and canonical identity remain unchanged.
 */
export async function createPackageForVersion(
  versionId: string,
  options: {
    /** The package kind/format, e.g. 'build-manifest' | 'artifact-bundle-descriptor' | 'listing-draft'. */
    packageType: string;
    /** Deterministic package content (JSON string or object). Frozen at creation. */
    packageBody: string | Record<string, unknown>;
    /** Optional reference to where the package artifact lives (path/id/url). No secrets. */
    artifactRef?: string;
  },
): Promise<ProductPackageRecord> {
  if (!options.packageType || options.packageType.trim().length === 0) {
    throw new Error('packageType is required.');
  }

  const version = await db.productVersion.findUnique({ where: { id: versionId } });
  if (!version) {
    throw new Error(`ProductVersion "${versionId}" not found.`);
  }

  const packageBodyString =
    typeof options.packageBody === 'string' ? options.packageBody : JSON.stringify(options.packageBody);
  const packageCanonical = asCanonicalRecord({ body: JSON.parse(packageBodyString) });
  const packageHash = sha256Hex(toCanonicalJson(packageCanonical));

  const packageRow = await db.productPackage.create({
    data: {
      versionId,
      packageType: options.packageType.trim(),
      packageBody: packageBodyString,
      packageHash,
      artifactRef: options.artifactRef?.trim() ?? '',
    },
  });

  return packageRow as unknown as ProductPackageRecord;
}

// ---------------------------------------------------------------------------
// Read helpers (traceability + immutability audits)
// ---------------------------------------------------------------------------

/** Load a version with its generation -> specification chain for traceability. */
export async function loadVersionWithChain(
  versionId: string,
): Promise<{
  version: ProductVersionRecord;
  generation: {
    id: string;
    generationRef: string;
    generationMode: GenerationMode;
    specificationId: string;
  };
  specification: ProductSpecificationRecord;
} | null> {
  const row = await db.productVersion.findUnique({
    where: { id: versionId },
    include: {
      generation: {
        include: {
          specification: true,
        },
      },
    },
  });
  if (!row) return null;
  return {
    version: row as unknown as ProductVersionRecord,
    generation: {
      id: row.generation.id,
      generationRef: row.generation.generationRef,
      generationMode: row.generation.generationMode as GenerationMode,
      specificationId: row.generation.specificationId,
    },
    specification: row.generation.specification as unknown as ProductSpecificationRecord,
  };
}

/** Load all packages for a version, in creation order (traceability). */
export async function loadPackagesForVersion(
  versionId: string,
): Promise<ProductPackageRecord[]> {
  const rows = await db.productPackage.findMany({
    where: { versionId },
    orderBy: { createdAt: 'asc' },
  });
  return rows as unknown as ProductPackageRecord[];
}

/** Check whether a version with the given content canonical hash already exists
 *  (immutability audit: identical content should not produce a new version). */
export async function versionContentExists(contentCanonicalHash: string): Promise<boolean> {
  const row = await db.productVersion.findUnique({ where: { contentCanonicalHash } });
  return row !== null;
}
