-- ===========================================================================
-- Phase B1 — Product Factory Core: specification → generation → version →
-- package. Additive only. No existing table is altered, renamed, or dropped.
-- ProductVersion links to the existing Product model as a plain column only
-- (no foreign key, no Prisma relation on Product).
-- ===========================================================================

-- ── ProductSpecification ───────────────────────────────────────────────────
-- Deterministic spec identity: one row per unique canonical hash. The hash is
-- derived from sorted-key canonical JSON (src/lib/product-factory/canonical.ts).
CREATE TABLE "ProductSpecification" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "canonicalBody" TEXT NOT NULL,
    "canonicalHash" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSpecification_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on canonicalHash: the real guard against duplicate specs.
-- The application does a read-then-write fast path; this constraint is the
-- backstop that makes concurrent creation idempotent.
CREATE UNIQUE INDEX "ProductSpecification_canonicalHash_key" ON "ProductSpecification"("canonicalHash");

-- Lookup by identity.
CREATE INDEX "ProductSpecification_canonicalHash_idx" ON "ProductSpecification"("canonicalHash");

-- ── ProductGeneration ──────────────────────────────────────────────────────
-- One concrete generation of a specification. Every generation preserves:
--   - the specification identity (specificationId)
--   - the generation mode (generationMode) — persisted, never request-only
--   - the resulting product version (ProductVersion)
CREATE TABLE "ProductGeneration" (
    "id" TEXT NOT NULL,
    "specificationId" TEXT NOT NULL,
    "generationMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcomeSummary" TEXT NOT NULL DEFAULT '{}',
    "generationRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ProductGeneration_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductGeneration_specificationId_createdAt_idx" ON "ProductGeneration"("specificationId", "createdAt");
CREATE INDEX "ProductGeneration_generationRef_idx" ON "ProductGeneration"("generationRef");

-- Foreign key to ProductSpecification.
ALTER TABLE "ProductGeneration"
  ADD CONSTRAINT "ProductGeneration_specificationId_fkey"
  FOREIGN KEY ("specificationId") REFERENCES "ProductSpecification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── ProductVersion ─────────────────────────────────────────────────────────
-- An immutable generated product version. A version is a historical artifact:
-- its canonical identity, generated content, and generation mode are never
-- overwritten. If the product should change, a NEW generation + NEW version is
-- created from the (possibly new) specification.
CREATE TABLE "ProductVersion" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "productId" TEXT,
    "versionLabel" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '{}',
    "generationMode" TEXT NOT NULL,
    "contentCanonicalHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVersion_pkey" PRIMARY KEY ("id")
);

-- One label per generation.
CREATE UNIQUE INDEX "ProductVersion_generationId_versionLabel_key" ON "ProductVersion"("generationId", "versionLabel");

-- One content per generation: prevents duplicate content within the same
-- generation, but allows different generations (different specs/modes) to each
-- have their own version with identical content — provenance is part of identity.
CREATE UNIQUE INDEX "ProductVersion_generationId_contentCanonicalHash_key" ON "ProductVersion"("generationId", "contentCanonicalHash");

CREATE INDEX "ProductVersion_generationId_idx" ON "ProductVersion"("generationId");
CREATE INDEX "ProductVersion_productId_idx" ON "ProductVersion"("productId");

-- Foreign key to ProductGeneration.
ALTER TABLE "ProductVersion"
  ADD CONSTRAINT "ProductVersion_generationId_fkey"
  FOREIGN KEY ("generationId") REFERENCES "ProductGeneration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── ProductPackage ─────────────────────────────────────────────────────────
-- A deterministic package/artifact representation for a generated product
-- version. A package is traceable to:
--   ProductSpecification -> ProductGeneration -> ProductVersion -> ProductPackage
CREATE TABLE "ProductPackage" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "packageType" TEXT NOT NULL,
    "packageBody" TEXT NOT NULL,
    "packageHash" TEXT NOT NULL,
    "artifactRef" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductPackage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductPackage_packageHash_key" ON "ProductPackage"("packageHash");

CREATE INDEX "ProductPackage_versionId_createdAt_idx" ON "ProductPackage"("versionId", "createdAt");
CREATE INDEX "ProductPackage_packageHash_idx" ON "ProductPackage"("packageHash");

-- Foreign key to ProductVersion.
ALTER TABLE "ProductPackage"
  ADD CONSTRAINT "ProductPackage_versionId_fkey"
  FOREIGN KEY ("versionId") REFERENCES "ProductVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
