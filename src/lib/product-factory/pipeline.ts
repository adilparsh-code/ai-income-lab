// ============================================================================
// PHASE B — PRODUCT CREATION PIPELINE (server-only)
// ============================================================================
// The durable pipeline that turns a VALIDATED opportunity into a concrete,
// persisted product package:
//
//   VALIDATED OPPORTUNITY
//     → PRODUCT SPECIFICATION      (ProductSpecification, versioned)
//     → PRODUCT GENERATION         (deterministic content, bounded)
//     → CONTENT / ASSET GENERATION (features, deliverables, usage, assets)
//     → QUALITY VALIDATION         (deterministic Product Quality Gate)
//     → HALAL / SAFETY VALIDATION  (EXISTING halal gate — no second system)
//     → LANDING PAGE GENERATION    (ProductLandingPage, non-payment CTA)
//     → PRODUCT PACKAGE            (ProductVersion — history preserved)
//     → READY_FOR_PUBLISHING       (spec record; lifecycle READY_TO_DEPLOY)
//
// Authority rules (unchanged):
//   - Product.status is mutated ONLY through the guarded lifecycle machine
//     (applyProductTransition). This module never writes Product.status
//     directly. VALIDATE → SPEC_READY → BUILD → START_TESTING → TEST_PASS
//     maps the pipeline onto the existing authoritative states, ending at
//     READY_TO_DEPLOY (the lifecycle's "ready for the next external gate").
//   - Safety reuses screenForHalalCompliance; this is an automated screening
//     control mechanism, NOT a religious ruling.
//   - Every generated field is DETERMINISTIC/MOCKED provenance. Market
//     evidence is UNAVAILABLE unless a real reference exists. AI output is
//     never fabricated here: with no AI credentials the deterministic adapter
//     is the truth, clearly labeled.
//   - Duplicate dispatch is deduplicated: an already-ready product is
//     returned as-is; a non-ready product gets a NEW spec version (previous
//     versions are preserved, never overwritten).
// ============================================================================

import { db } from '@/lib/db';
import { logger } from '@/lib/server-log';
import { applyProductTransition } from './lifecycle-service';
import { screenForHalalCompliance } from '@/lib/halal-filter';
import type { HalalStatus } from '@/lib/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const PRODUCT_PIPELINE_SPEC_STATUSES = [
  'DRAFT', 'GENERATING', 'GENERATED', 'VALIDATING',
  'READY_FOR_PUBLISHING', 'QUALITY_FAILED', 'SAFETY_FAILED', 'FAILED',
] as const;
export type ProductPipelineSpecStatus = (typeof PRODUCT_PIPELINE_SPEC_STATUSES)[number];

/**
 * Phase B — canonical pipeline stages (durable contract).
 *
 * The pipeline is the ONLY executor of these stages, and every one maps onto
 * the guarded product lifecycle machine (applyProductTransition), so Product
 * status transitions through the defined stages exactly once per spec
 * version:
 *
 *   PRODUCT_SPECIFICATION       VALIDATE → SPEC_READY (spec row persisted)
 *   PRODUCT_GENERATION          BUILD (deterministic content)
 *   CONTENT_ASSET_GENERATION    features/deliverables/usage/assets persisted
 *   QUALITY_VALIDATION          START_TESTING (deterministic quality gate)
 *   HALAL_SAFETY_VALIDATION     EXISTING halal screen (BLOCK/REVIEW on fail)
 *   LANDING_PAGE_GENERATION     landing row persisted (non-payment CTA)
 *   PRODUCT_PACKAGE             TEST_PASS → READY_TO_DEPLOY + version row
 *   READY_FOR_PUBLISHING        terminal creation record; publishing is the
 *                               NEXT capability and stays NOT_CONFIGURED
 *
 * Pre-stages (opportunity lookup, halal pre-check, artifact, dedup) are
 * recorded with name=null so the canonical trace contains exactly these 8
 * names in order on success.
 */
export const PRODUCT_PIPELINE_STAGES = [
  'PRODUCT_SPECIFICATION',
  'PRODUCT_GENERATION',
  'CONTENT_ASSET_GENERATION',
  'QUALITY_VALIDATION',
  'HALAL_SAFETY_VALIDATION',
  'LANDING_PAGE_GENERATION',
  'PRODUCT_PACKAGE',
  'READY_FOR_PUBLISHING',
] as const;
export type ProductPipelineStageName = (typeof PRODUCT_PIPELINE_STAGES)[number];

export type ProductPipelineFinalStatus =
  | 'READY_FOR_PUBLISHING'
  | 'QUALITY_FAILED'
  | 'SAFETY_FAILED'
  | 'HUMAN_REVIEW'
  | 'BLOCKED'
  | 'FAILED';

export type ProductPipelineStageStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'HUMAN_REVIEW' | 'DEDUPLICATED';

export interface ProductPipelineStage {
  id: string;
  /** Canonical stage name (null for pre-stages outside the 8-stage contract). */
  name: ProductPipelineStageName | null;
  label: string;
  status: ProductPipelineStageStatus;
  detail: string;
  at: string;
}

export interface ProductPipelineResult {
  ok: boolean;
  finalStatus: ProductPipelineFinalStatus;
  productId: string;
  specificationId: string;
  version: number;
  landingPageId: string | null;
  productLifecycleStatus: string;
  stages: ProductPipelineStage[];
  correlationId: string | null;
  failureReason: string | null;
  qualityGates: ProductQualityGate[];
}

/** Phase B product types the deterministic generator supports. */
export const PIPELINE_PRODUCT_TYPES = [
  'DIGITAL_PRODUCT', 'DIGITAL_GUIDE', 'CHECKLIST', 'TEMPLATE',
  'WORKSHEET', 'STUDY_MATERIAL', 'DIGITAL_UTILITY',
] as const;
export type PipelineProductType = (typeof PIPELINE_PRODUCT_TYPES)[number];

// ---------------------------------------------------------------------------
// Bounded, control-char-safe text (same spirit as the research boundary)
// ---------------------------------------------------------------------------

const MAX_TEXT = 500;
const MAX_TITLE = 160;
const MAX_POINT = 240;
const MAX_SECTIONS = 6;

/** Strip control characters, collapse whitespace, hard-cap length. */
export function capText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed;
}

function capList(values: unknown, itemMax: number, listMax: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, listMax)
    .map((v) => capText(v, itemMax))
    .filter((v) => v.length > 0);
}

/** Split a sentence-ish string into capped clauses for checklist points. */
function toPoints(value: string, maxPoints: number): string[] {
  const parts = value
    .split(/[.;\n]|\u2022/)
    .map((p) => capText(p, MAX_POINT))
    .filter((p) => p.length >= 8);
  return parts.slice(0, maxPoints);
}

function sentences(value: string, max: number): string[] {
  const raw = value
    .split(/(?<=[.!?])\s+/)
    .map((s) => capText(s, MAX_POINT))
    .filter((s) => s.length >= 12);
  return raw.slice(0, max);
}

// ---------------------------------------------------------------------------
// Opportunity → product type derivation (deterministic)
// ---------------------------------------------------------------------------

const DERIVATION_RULES: Array<{ pattern: RegExp; type: PipelineProductType }> = [
  { pattern: /checklist|audit|inventory|compliance/i, type: 'CHECKLIST' },
  { pattern: /template|spreadsheet|planner|notion|form/i, type: 'TEMPLATE' },
  { pattern: /worksheet|exercise|practice|drill|workbook/i, type: 'WORKSHEET' },
  { pattern: /calculator|tracker|utility|tool|dashboard/i, type: 'DIGITAL_UTILITY' },
  { pattern: /course|study|exam|curriculum|lesson|training/i, type: 'STUDY_MATERIAL' },
  { pattern: /guide|handbook|tutorial|how[- ]to/i, type: 'DIGITAL_GUIDE' },
];

export function deriveProductType(input: {
  title: string;
  category: string;
  businessModel: string;
  requested?: unknown;
}): PipelineProductType {
  const requested = typeof input.requested === 'string' ? input.requested.trim().toUpperCase() : '';
  if ((PIPELINE_PRODUCT_TYPES as readonly string[]).includes(requested)) {
    return requested as PipelineProductType;
  }
  const text = `${input.title} ${input.category} ${input.businessModel}`;
  for (const rule of DERIVATION_RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return 'DIGITAL_PRODUCT';
}

// ---------------------------------------------------------------------------
// Deterministic content generation (bounded, clearly labeled)
// ---------------------------------------------------------------------------

interface GeneratedContent {
  shortDescription: string;
  detailedDescription: string;
  features: string[];
  deliverables: string[];
  requirements: string[];
  usageInstructions: string[];
  contentOutline: Array<{ id: string; title: string; purpose: string; points: string[]; instructions?: string }>;
  assetRequirements: string[];
}

const TYPE_PROFILES: Record<PipelineProductType, { label: string; format: string; deliverable: string; assets: string[] }> = {
  DIGITAL_PRODUCT: {
    label: 'Structured digital product', format: 'PDF document', deliverable: 'Downloadable PDF document',
    assets: ['Cover page (placeholder, no fabricated branding)', 'Printable A4 layout'],
  },
  DIGITAL_GUIDE: {
    label: 'Step-by-step digital guide', format: 'PDF guide', deliverable: 'Downloadable step-by-step guide (PDF)',
    assets: ['Cover page (placeholder)', 'Section dividers (text-only)'],
  },
  CHECKLIST: {
    label: 'Actionable checklist', format: 'Printable checklist (PDF)', deliverable: 'Printable checklist (PDF)',
    assets: ['Checkbox grid layout (placeholder)', 'Printable A4 layout'],
  },
  TEMPLATE: {
    label: 'Reusable template', format: 'Editable template file', deliverable: 'Editable template file with instructions',
    assets: ['Template layout (placeholder)', 'Fill-in fields'],
  },
  WORKSHEET: {
    label: 'Practice worksheet set', format: 'Printable worksheets (PDF)', deliverable: 'Printable worksheet set (PDF)',
    assets: ['Worksheet layout (placeholder)', 'Answer-space areas'],
  },
  STUDY_MATERIAL: {
    label: 'Structured study material', format: 'Lesson notes (PDF)', deliverable: 'Structured lesson notes with review questions (PDF)',
    assets: ['Lesson layout (placeholder)', 'Review-question blocks'],
  },
  DIGITAL_UTILITY: {
    label: 'Simple digital utility specification', format: 'Utility specification document', deliverable: 'Utility specification document (calculator/tool spec)',
    assets: ['Input/output field table (placeholder)', 'Formula documentation'],
  },
};

export function generateDeterministicContent(input: {
  title: string;
  problemSolved: string;
  targetAudience: string;
  coreValue: string;
  productType: PipelineProductType;
}): GeneratedContent {
  const profile = TYPE_PROFILES[input.productType];
  const problemPoints = toPoints(input.problemSolved, 4);
  const audiencePoints = toPoints(input.targetAudience, 3).length > 0
    ? toPoints(input.targetAudience, 3)
    : [capText('Defined by the validated opportunity record.', MAX_POINT)];
  const problemSentences = sentences(input.problemSolved, 3);
  const valueSentences = sentences(input.coreValue, 2);

  const sections: GeneratedContent['contentOutline'] = [
    {
      id: 's1',
      title: 'Understanding the problem',
      purpose: 'Frame the problem this product addresses, from the validated opportunity record.',
      points: problemPoints.length > 0 ? problemPoints : [capText(input.problemSolved, MAX_POINT)],
      instructions: 'Read this section before starting; it defines the scope of the product.',
    },
    {
      id: 's2',
      title: 'Who this is for',
      purpose: 'Define the target user and their situation.',
      points: audiencePoints,
    },
    {
      id: 's3',
      title: input.productType === 'CHECKLIST'
        ? 'The checklist'
        : input.productType === 'TEMPLATE'
          ? 'Template structure'
          : input.productType === 'WORKSHEET'
            ? 'Practice exercises'
            : input.productType === 'STUDY_MATERIAL'
              ? 'Lesson outline'
              : input.productType === 'DIGITAL_UTILITY'
                ? 'Tool specification'
                : 'Core walkthrough',
      purpose: `The core ${profile.label.toLowerCase()} content, derived from the opportunity record.`,
      points: problemSentences.length > 0
        ? problemSentences
        : [capText(input.problemSolved, MAX_POINT)],
    },
    {
      id: 's4',
      title: 'Putting it into practice',
      purpose: 'Concrete usage steps.',
      points: valueSentences.length > 0
        ? valueSentences
        : [capText(input.coreValue, MAX_POINT)],
      instructions: 'Work through each step in order; skip nothing on the first pass.',
    },
    {
      id: 's5',
      title: 'Measuring your progress',
      purpose: 'How the user knows it is working.',
      points: [
        'Record your starting point before applying the material.',
        'Review after each session and note what changed.',
        'Revisit sections that produced no measurable change.',
      ],
    },
  ].slice(0, MAX_SECTIONS);

  return {
    shortDescription: capText(`${profile.label} based on a validated opportunity: ${input.title}`, 300),
    detailedDescription: capText(
      `${profile.label} ("${input.title}"). Problem addressed: ${input.problemSolved} `
      + `Intended audience: ${input.targetAudience}. Core value: ${input.coreValue} `
      + `Format: ${profile.format}. Generated by the deterministic (MOCKED) pipeline — `
      + `clearly not live AI output; human review is required before any external use.`,
      MAX_TEXT,
    ),
    features: capList([
      profile.deliverable,
      'Problem framing from the validated opportunity record',
      'Target-audience definition',
      input.productType === 'CHECKLIST' ? 'Step-by-step checklist with checkboxes' : 'Guided sections with instructions',
      'Progress-tracking guidance',
    ], MAX_POINT, 5),
    deliverables: capList([profile.deliverable, 'Usage instructions page'], MAX_POINT, 4),
    requirements: capList([
      'PDF reader or compatible editor',
      'No additional software required',
    ], MAX_POINT, 4),
    usageInstructions: capList([
      'Download the product after it is published by a human-approved publishing capability (not yet connected).',
      'Read "Understanding the problem" first to confirm the product matches your situation.',
      'Work through the core section in order.',
      'Use "Measuring your progress" to evaluate outcomes.',
    ], MAX_POINT, 5),
    contentOutline: sections,
    assetRequirements: capList(profile.assets, MAX_POINT, 4),
  };
}

// ---------------------------------------------------------------------------
// Spec assembly from a real opportunity record
// ---------------------------------------------------------------------------

interface OpportunityInput {
  id: string;
  title: string;
  category: string;
  businessModel: string;
  targetAudience: string;
  problemSolved: string;
  monetizationMethod: string;
  overallScore: number;
  halalStatus: string;
  status: string;
  evidenceNotes: string;
}

function buildSpecificationFields(opp: OpportunityInput, productType: PipelineProductType) {
  const content = generateDeterministicContent({
    title: capText(opp.title, MAX_TITLE),
    problemSolved: capText(opp.problemSolved, MAX_TEXT),
    targetAudience: capText(opp.targetAudience, MAX_TEXT),
    coreValue: capText(
      `A ${TYPE_PROFILES[productType].label.toLowerCase()} that addresses: ${opp.problemSolved}`,
      MAX_TEXT,
    ),
    productType,
  });
  const title = capText(opp.title, MAX_TITLE);
  return {
    title,
    shortDescription: content.shortDescription,
    detailedDescription: content.detailedDescription,
    targetAudience: capText(opp.targetAudience, MAX_TEXT),
    problemSolved: capText(opp.problemSolved, MAX_TEXT),
    coreValue: capText(`Addresses: ${opp.problemSolved}`, MAX_TEXT),
    productType,
    productFormat: TYPE_PROFILES[productType].format,
    features: JSON.stringify(content.features),
    deliverables: JSON.stringify(content.deliverables),
    requirements: JSON.stringify(content.requirements),
    usageInstructions: JSON.stringify(content.usageInstructions),
    contentOutline: JSON.stringify(content.contentOutline),
    assetRequirements: JSON.stringify(content.assetRequirements),
    qualityCriteria: JSON.stringify([
      'All required specification fields present',
      'At least 3 content sections with actionable points',
      'No prohibited, deceptive, or unsupported claims',
      'No accidental secrets in generated content',
      'Safety screening passed (automated control, not a religious ruling)',
    ]),
    pricingPlaceholder: 'PRICING_PLACEHOLDER_NOT_SET',
    marketPositioning: capText(
      `Deterministic hypothesis derived from the opportunity record (score ${opp.overallScore}, `
      + `confidence data recorded by the validation layer). No live market evidence is implied.`,
      MAX_TEXT,
    ),
    marketEvidence: 'UNAVAILABLE',
  };
}

// ---------------------------------------------------------------------------
// Product Quality Gate (deterministic)
// ---------------------------------------------------------------------------

export interface ProductQualityGate {
  id: string;
  label: string;
  passed: boolean;
  reason: string;
}

const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'openai-style-key', re: /sk-[A-Za-z0-9_-]{16,}/ },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'credential-assignment', re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|bearer)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
];

const MARKET_CLAIM_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'guarantee', re: /\bguaranteed?\b|\brisk[- ]free\b|\bno risk\b/i },
  { id: 'proven-claims', re: /\bproven to (make|earn|generate|work)\b|\b100% success\b/i },
  { id: 'income-claims', re: /\bget rich\b|\bpassive income guaranteed\b|\bmake money fast\b|\bguaranteed income\b/i },
  { id: 'instant-results', re: /\binstant results\b|\bearn while you sleep\b/i },
];

const FAKE_TESTIMONIAL_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'testimonial-section', re: /\btestimonial(s)?\b/i },
  { id: 'fabricated-social-proof', re: /\bour (customers|users) say\b|\bcustomers (are )?say(ing)?\b|\bverified reviews? from real (users|customers)\b|\b5[- ]star reviews? from (real|happy)\b/i },
  { id: 'invented-quotes', re: /[""]?[^""]{10,80}[""]?\s*—\s*[A-Z][a-z]+ [A-Z]\./ },
];

const PLACEHOLDER_PATTERNS: RegExp = /\bTODO\b|\bFIXME\b|lorem ipsum|\[object Object\]|\bundefined\b|\bnull,null\b/i;

function specDocText(spec: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const value of Object.values(spec)) {
    if (typeof value === 'string') parts.push(value);
    else if (value != null) parts.push(JSON.stringify(value));
  }
  return parts.join('\n');
}

export interface QualityGateInput {
  title: string;
  shortDescription: string;
  detailedDescription: string;
  targetAudience: string;
  problemSolved: string;
  coreValue: string;
  productType: string;
  productFormat: string;
  features: string;
  deliverables: string;
  requirements: string;
  usageInstructions: string;
  contentOutline: string;
  assetRequirements: string;
  qualityCriteria: string;
  provenance: string;
  correlationId: string | null;
  version: number;
  opportunityId: string | null;
  productId: string;
}

/** Deterministic quality gate. Every check explains itself; nothing passes silently. */
export function runProductQualityGate(spec: QualityGateInput): { passed: boolean; gates: ProductQualityGate[] } {
  const gates: ProductQualityGate[] = [];
  const add = (id: string, label: string, passed: boolean, reason: string) =>
    gates.push({ id, label, passed, reason: capText(reason, 300) });

  const required: Array<[string, string]> = [
    ['title', spec.title], ['shortDescription', spec.shortDescription],
    ['targetAudience', spec.targetAudience], ['problemSolved', spec.problemSolved],
    ['coreValue', spec.coreValue], ['productType', spec.productType],
    ['productFormat', spec.productFormat],
  ];
  const missing = required.filter(([, v]) => !v || v.trim().length === 0).map(([k]) => k);
  add('required_fields', 'Required fields present', missing.length === 0,
    missing.length === 0 ? 'All required fields are non-empty.' : `Missing/empty: ${missing.join(', ')}`);

  let outline: Array<{ title?: unknown; points?: unknown }> = [];
  let outlineOk = false;
  try {
    const parsed = JSON.parse(spec.contentOutline);
    if (Array.isArray(parsed) && parsed.length >= 3) {
      outline = parsed;
      outlineOk = parsed.every((s) => s && typeof s === 'object'
        && typeof s.title === 'string' && s.title.trim().length > 0
        && Array.isArray(s.points) && s.points.length >= 1);
    }
  } catch { outlineOk = false; }
  add('content_completeness', 'Minimum content completeness', outlineOk,
    outlineOk ? `${outline.length} sections with points present.` : 'Need ≥3 sections, each with a title and ≥1 point.');

  const featuresOk = (() => { try { const f = JSON.parse(spec.features); return Array.isArray(f) && f.length >= 3; } catch { return false; } })();
  add('feature_completeness', 'Feature completeness', featuresOk,
    featuresOk ? 'Features list present.' : 'Need ≥3 features.');

  const deliverablesOk = (() => { try { const d = JSON.parse(spec.deliverables); return Array.isArray(d) && d.length >= 1; } catch { return false; } })();
  const usageOk = (() => { try { const u = JSON.parse(spec.usageInstructions); return Array.isArray(u) && u.length >= 1; } catch { return false; } })();
  add('deliverables_and_usage', 'Deliverables and usage instructions', deliverablesOk && usageOk,
    deliverablesOk && usageOk ? 'Deliverables and usage instructions present.' : 'Need ≥1 deliverable and ≥1 usage instruction.');

  add('opportunity_reference', 'Valid opportunity reference',
    typeof spec.opportunityId === 'string' && spec.opportunityId.length > 0,
    spec.opportunityId ? `Linked to opportunity ${spec.opportunityId}.` : 'No opportunity reference — provenance chain is broken.');

  add('provenance_exists', 'Provenance exists',
    spec.provenance.trim().length > 0 && typeof spec.correlationId === 'string' && spec.correlationId.length > 0,
    `Provenance "${spec.provenance}", correlation ${spec.correlationId ? 'recorded' : 'MISSING'}.`);

  const jsonFields = ['features', 'deliverables', 'requirements', 'usageInstructions', 'contentOutline', 'assetRequirements', 'qualityCriteria'] as const;
  const malformed = jsonFields.filter((f) => { try { JSON.parse(spec[f]); return false; } catch { return true; } });
  add('structured_content_valid', 'Structured content well-formed', malformed.length === 0,
    malformed.length === 0 ? 'All JSON fields parse.' : `Malformed JSON: ${malformed.join(', ')}`);

  const doc = specDocText(spec as unknown as Record<string, unknown>);
  const placeholderHit = PLACEHOLDER_PATTERNS.test(doc);
  add('no_placeholder_content', 'No placeholder/junk content', !placeholderHit,
    placeholderHit ? 'Placeholder or junk markers found in generated content.' : 'No placeholder markers.');

  const secretHit = SECRET_PATTERNS.find((p) => p.re.test(doc));
  add('no_accidental_secrets', 'No accidental secrets', !secretHit,
    secretHit ? `Secret-like pattern detected (${secretHit.id}).` : 'No secret-like patterns.');

  const claimHit = MARKET_CLAIM_PATTERNS.find((p) => p.re.test(doc));
  add('no_unsupported_market_claims', 'No unsupported market claims', !claimHit,
    claimHit
      ? `Unsupported market claim detected (${claimHit.id}). Market evidence is UNAVAILABLE; such claims cannot be supported.`
      : 'No unsupported market claims. Market evidence marked UNAVAILABLE.');

  const testimonialHit = FAKE_TESTIMONIAL_PATTERNS.find((p) => p.re.test(doc));
  add('no_fake_testimonials', 'No fake testimonials/social proof', !testimonialHit,
    testimonialHit ? `Fabricated social-proof pattern detected (${testimonialHit.id}).` : 'No fabricated social proof.');

  add('version_consistency', 'Version consistency',
    Number.isInteger(spec.version) && spec.version >= 1,
    `Spec version ${spec.version}.`);

  add('artifact_exists', 'Product artifact exists',
    spec.productId.trim().length > 0,
    spec.productId ? `Artifact bound to product ${spec.productId}.` : 'No product artifact.');

  return { passed: gates.every((g) => g.passed), gates };
}

// ---------------------------------------------------------------------------
// Safety gate (EXISTING halal filter — no second safety system)
// ---------------------------------------------------------------------------

export interface ProductSafetyResult {
  status: HalalStatus;
  reasons: string[];
  policyVersion: string;
  checkedAt: string;
}

export function screenProductSafety(input: {
  title: string;
  detailedDescription: string;
  category: string;
  businessModel: string;
  monetizationMethod: string;
}): ProductSafetyResult {
  const screen = screenForHalalCompliance(
    input.title, input.detailedDescription, input.category,
    input.businessModel, input.monetizationMethod,
  );
  const policyVersion = process.env.HALAL_POLICY_VERSION?.trim() || 'halal-filter-v1';
  return {
    status: screen.status,
    reasons: screen.reasons.slice(0, 10),
    policyVersion,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Landing page generation (deterministic, non-payment CTA)
// ---------------------------------------------------------------------------

export function generateLandingPageFields(spec: {
  title: string;
  problemSolved: string;
  targetAudience: string;
  coreValue: string;
  features: string;
  deliverables: string;
  contentOutline: string;
}): Record<string, string> {
  const features = safeParseArray(spec.features, 5);
  const deliverables = safeParseArray(spec.deliverables, 4);
  const sections = safeParseArray(spec.contentOutline, MAX_SECTIONS) as Array<{ title?: unknown; purpose?: unknown }>;
  const howItWorks = sections
    .map((s, i) => `${i + 1}. ${capText(typeof s.title === 'string' ? s.title : 'Section', 120)}`)
    .slice(0, MAX_SECTIONS);
  return {
    headline: capText(spec.title, MAX_TITLE),
    problem: capText(spec.problemSolved, MAX_TEXT),
    targetAudience: capText(spec.targetAudience, 300),
    valueProposition: capText(spec.coreValue, MAX_TEXT),
    features: JSON.stringify(features),
    whatsIncluded: JSON.stringify(deliverables),
    howItWorks: JSON.stringify(howItWorks),
    faq: JSON.stringify([
      { q: 'Is this available for purchase yet?', a: 'Not yet. Publishing is a future capability and is not connected; the CTA on this page is a non-payment placeholder.' },
      { q: 'How was this product created?', a: 'By a deterministic pipeline from a validated opportunity record. Generated material is clearly labeled and requires human review before external use.' },
      { q: 'Are there income or result guarantees?', a: 'No. No income or results are promised, and no market outcome is claimed.' },
    ]),
    ctaType: 'COMING_SOON',
    ctaLabel: 'Coming Soon',
    safetyNote: capText(
      'Automated screening applied (halal/safety control mechanism, not a religious ruling). '
      + 'No payment or checkout is implemented; no purchase is possible from this page.',
      400,
    ),
    status: 'READY',
    provenance: 'DETERMINISTIC',
  };
}

function safeParseArray(json: string, max: number): unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.slice(0, max) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pipeline state resolution (pure; consumed by Business Manager routing)
// ---------------------------------------------------------------------------

/** Deterministic product-level pipeline state derived from persisted rows. */
export type ProductPipelineState =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'QUALITY_FAILED'
  | 'SAFETY_FAILED'
  | 'BLOCKED'
  | 'READY_FOR_PUBLISHING'
  | 'BEYOND_PIPELINE';

const BEYOND_PRODUCT_STATUSES = ['DEPLOYED', 'PUBLISHED', 'EARNING', 'IMPROVING'];

/**
 * Resolve one product's Phase B pipeline state from REAL persisted rows
 * (Product.status + its latest ProductSpecification.status). Never guesses:
 * unknown spec statuses are IN_PROGRESS, and a missing spec is NOT_STARTED.
 */
export function resolveProductPipelineState(input: {
  productStatus: string;
  latestSpecStatus: string | null;
}): ProductPipelineState {
  if (input.productStatus === 'BLOCKED') return 'BLOCKED';
  if (BEYOND_PRODUCT_STATUSES.includes(input.productStatus)) return 'BEYOND_PIPELINE';
  if (!input.latestSpecStatus) return 'NOT_STARTED';
  if (input.latestSpecStatus === 'READY_FOR_PUBLISHING') return 'READY_FOR_PUBLISHING';
  if (input.latestSpecStatus === 'QUALITY_FAILED') return 'QUALITY_FAILED';
  if (input.latestSpecStatus === 'SAFETY_FAILED') return 'SAFETY_FAILED';
  return 'IN_PROGRESS';
}

/**
 * Pick the state that drives routing when an opportunity has several
 * products. Safety dominates, then progress: a blocked product forces human
 * review, a published/deployed product is beyond this pipeline, a ready
 * package routes to the (human-gated) publishing capability, and any
 * unfinished work routes to pipeline resume.
 */
export function selectRoutingPipelineState(states: ProductPipelineState[]): ProductPipelineState {
  if (states.includes('BLOCKED')) return 'BLOCKED';
  if (states.includes('BEYOND_PIPELINE')) return 'BEYOND_PIPELINE';
  if (states.includes('READY_FOR_PUBLISHING')) return 'READY_FOR_PUBLISHING';
  if (states.includes('SAFETY_FAILED')) return 'SAFETY_FAILED';
  if (states.includes('QUALITY_FAILED')) return 'QUALITY_FAILED';
  if (states.includes('IN_PROGRESS')) return 'IN_PROGRESS';
  return 'NOT_STARTED';
}

// ---------------------------------------------------------------------------
// Guarded transition helper (Product.status is ONLY changed via the machine)
// ---------------------------------------------------------------------------

async function tryTransition(productId: string, transition: Parameters<typeof applyProductTransition>[0]['transition'], note: string): Promise<boolean> {
  const decision = await applyProductTransition({ productId, transition });
  if (!decision.ok) {
    logger.info('Product pipeline transition skipped (guarded machine refused)', {
      productId, transition, reason: decision.reason, note,
    });
  }
  return decision.ok;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface RunProductPipelineInput {
  opportunityId: string;
  productType?: unknown;
  correlationId?: string | null;
}

function stage(
  id: string,
  name: ProductPipelineStageName | null,
  label: string,
  status: ProductPipelineStageStatus,
  detail: string,
): ProductPipelineStage {
  return { id, name, label, status, detail: capText(detail, 400), at: new Date().toISOString() };
}

export async function runProductPipeline(input: RunProductPipelineInput): Promise<ProductPipelineResult> {
  const correlationId = capText(input.correlationId ?? '', 128) || null;
  const stages: ProductPipelineStage[] = [];

  // 1. Load the opportunity — the provenance root. Nothing is invented.
  const opp = await db.opportunity.findUnique({ where: { id: input.opportunityId } });
  if (!opp) {
    return failureResult(null, null, 'BLOCKED', 0, `Opportunity ${input.opportunityId} not found; no product created.`,
      [stage('opportunity', null, 'Opportunity lookup', 'BLOCKED', `Opportunity ${input.opportunityId} not found.`)], null);
  }
  stages.push(stage('opportunity', null, 'Opportunity lookup', 'PASSED',
    `Opportunity "${capText(opp.title, 80)}" (halal ${opp.halalStatus}, score ${opp.overallScore}).`));

  if (opp.halalStatus === 'NOT_ALLOWED') {
    return failureResult(null, null, 'BLOCKED', 0,
      'Opportunity halalStatus is NOT_ALLOWED. No product is created and no build work is performed.',
      [...stages, stage('halal_precheck', null, 'Safety pre-check', 'BLOCKED', 'NOT_ALLOWED: pipeline refused before any generation.')],
      correlationId);
  }
  if (opp.halalStatus === 'REVIEW_REQUIRED') {
    return failureResult(null, null, 'HUMAN_REVIEW', 0,
      'Opportunity halalStatus is REVIEW_REQUIRED. A qualified human must review before the pipeline may run; nothing was generated.',
      [...stages, stage('halal_precheck', null, 'Safety pre-check', 'HUMAN_REVIEW', 'REVIEW_REQUIRED: pipeline paused before any generation.')],
      correlationId);
  }

  const oppInput: OpportunityInput = {
    id: opp.id, title: opp.title, category: opp.category, businessModel: opp.businessModel,
    targetAudience: opp.targetAudience, problemSolved: opp.problemSolved,
    monetizationMethod: opp.monetizationMethod, overallScore: opp.overallScore,
    halalStatus: opp.halalStatus, status: opp.status, evidenceNotes: opp.evidenceNotes,
  };
  const productType = deriveProductType({
    title: opp.title, category: opp.category, businessModel: opp.businessModel,
    requested: input.productType,
  });

  // 2. Deduplication: an existing READY product is returned; a non-ready one
  //    gets a NEW spec version (previous versions preserved).
  const existing = await db.product.findFirst({
    where: { opportunityId: opp.id },
    orderBy: { createdAt: 'desc' },
    include: { specifications: { orderBy: { version: 'desc' }, take: 1 } },
  });

  let product: { id: string; status: string } | null = existing
    ? { id: existing.id, status: existing.status }
    : null;
  const existingLatest = existing?.specifications?.[0] ?? null;
  const alreadyReady = existing
    && existing.status === 'READY_TO_DEPLOY'
    && existingLatest?.status === 'READY_FOR_PUBLISHING';

  if (alreadyReady && existing && existingLatest) {
    stages.push(stage('dedup', 'READY_FOR_PUBLISHING', 'Duplicate dispatch check', 'DEDUPLICATED',
      `Product already READY_FOR_PUBLISHING (spec v${existingLatest.version}); returning existing package without re-generating.`));
    return {
      ok: true,
      finalStatus: 'READY_FOR_PUBLISHING',
      productId: existing.id,
      specificationId: existingLatest.id,
      version: existingLatest.version,
      landingPageId: null,
      productLifecycleStatus: existing.status,
      stages,
      correlationId,
      failureReason: null,
      qualityGates: [],
    };
  }

  const version = (existingLatest?.version ?? 0) + 1;
  const resumed = existing != null;

  // 3. Product artifact (create once per opportunity; reused on resume).
  if (!product) {
    const created = await db.product.create({
      data: {
        name: capText(opp.title, MAX_TITLE),
        type: productType,
        targetAudience: capText(opp.targetAudience, 300),
        status: 'IDEA',
        opportunityId: opp.id,
        notes: JSON.stringify({
          phaseB: 'pipeline-created',
          generationMode: 'DETERMINISTIC',
          provenance: 'MOCKED',
          correlationId,
        }),
      },
    });
    product = { id: created.id, status: created.status };
  }
  stages.push(stage('artifact', null, 'Product artifact', 'PASSED',
    resumed ? `Existing product reused for new spec version v${version}.` : 'Product artifact created (status IDEA).'));

  const fields = buildSpecificationFields(oppInput, productType);

  // 4. Specification (versioned; DRAFT → GENERATING → GENERATED).
  const createdSpec = await db.productSpecification.create({
    data: {
      productId: product.id,
      opportunityId: opp.id,
      version,
      status: 'GENERATING',
      provenance: 'MOCKED',
      generationMode: 'DETERMINISTIC',
      providerModel: '',
      correlationId,
      ...fields,
    },
  });
  stages.push(stage('specification', 'PRODUCT_SPECIFICATION', 'Product specification', 'PASSED', `Spec v${version} persisted (status GENERATING).`));

  // Lifecycle: VALIDATE → SPEC_READY (guarded; refusals recorded, not fatal).
  await tryTransition(product.id, 'VALIDATE', 'pipeline');
  await tryTransition(product.id, 'SPEC_READY', 'pipeline');

  // 5. Content generation (deterministic; already computed above).
  const generated = generateDeterministicContent({
    title: fields.title, problemSolved: fields.problemSolved,
    targetAudience: fields.targetAudience, coreValue: fields.coreValue,
    productType,
  });
  await db.productSpecification.update({
    where: { id: createdSpec.id },
    data: { status: 'GENERATED' },
  });
  stages.push(stage('generation', 'PRODUCT_GENERATION', 'Product generation', 'PASSED',
    `Deterministic content generated (${generated.contentOutline.length} sections, ${generated.features.length} features); provenance MOCKED/DETERMINISTIC.`));

  // CONTENT_ASSET_GENERATION: the asset set ships with the spec row —
  // features, deliverables, requirements, usage instructions, and asset
  // requirements are persisted JSON, never a temporary AI response.
  stages.push(stage('assets', 'CONTENT_ASSET_GENERATION', 'Content/asset generation', 'PASSED',
    `Persisted on spec v${version}: ${generated.features.length} features, ${generated.deliverables.length} deliverables, `
      + `${generated.requirements.length} requirements, ${generated.usageInstructions.length} usage instructions, `
      + `${generated.assetRequirements.length} asset requirements.`));

  await tryTransition(product.id, 'BUILD', 'pipeline: generation complete');

  // 6. Quality gate.
  await db.productSpecification.update({
    where: { id: createdSpec.id },
    data: { status: 'VALIDATING' },
  });
  await tryTransition(product.id, 'START_TESTING', 'pipeline: quality gate');

  const specForGate: QualityGateInput = {
    ...(fields as unknown as QualityGateInput),
    provenance: 'MOCKED',
    correlationId,
    version,
    opportunityId: opp.id,
    productId: product.id,
  };
  const quality = runProductQualityGate(specForGate);
  if (!quality.passed) {
    const failed = quality.gates.filter((g) => !g.passed);
    await db.productSpecification.update({
      where: { id: createdSpec.id },
      data: {
        status: 'QUALITY_FAILED',
        qualityGates: JSON.stringify(quality.gates),
      },
    });
    await tryTransition(product.id, 'TEST_FAIL', 'pipeline: quality gate failed');
    stages.push(stage('quality', 'QUALITY_VALIDATION', 'Product quality gate', 'FAILED',
      `Failed gates: ${failed.map((g) => g.id).join(', ')}.`));
    return {
      ok: false,
      finalStatus: 'QUALITY_FAILED',
      productId: product.id,
      specificationId: createdSpec.id,
      version,
      landingPageId: null,
      productLifecycleStatus: (await db.product.findUnique({ where: { id: product.id } }))?.status ?? 'UNKNOWN',
      stages,
      correlationId,
      failureReason: `Quality gate failed: ${failed.map((g) => `${g.id} (${g.reason})`).join('; ')}`,
      qualityGates: quality.gates,
    };
  }
  stages.push(stage('quality', 'QUALITY_VALIDATION', 'Product quality gate', 'PASSED', 'All quality gates passed.'));

  // 7. Safety gate (EXISTING halal filter).
  const safety = screenProductSafety({
    title: fields.title,
    detailedDescription: `${fields.detailedDescription} ${JSON.stringify(generated.contentOutline)}`,
    category: opp.category,
    businessModel: opp.businessModel,
    monetizationMethod: opp.monetizationMethod,
  });
  await db.productSpecification.update({
    where: { id: createdSpec.id },
    data: {
      halalSafetyStatus: safety.status,
      halalReasons: JSON.stringify(safety.reasons),
      halalCheckedAt: new Date(safety.checkedAt),
      halalPolicyVersion: safety.policyVersion,
      qualityGates: JSON.stringify(quality.gates),
    },
  });

  if (safety.status === 'NOT_ALLOWED') {
    await tryTransition(product.id, 'BLOCK', 'pipeline: safety gate NOT_ALLOWED');
    await db.productSpecification.update({
      where: { id: createdSpec.id },
      data: { status: 'SAFETY_FAILED' },
    });
    stages.push(stage('safety', 'HALAL_SAFETY_VALIDATION', 'Halal/safety gate', 'BLOCKED',
      `NOT_ALLOWED: ${safety.reasons.join('; ') || 'policy match'}.`));
    return {
      ok: false,
      finalStatus: 'SAFETY_FAILED',
      productId: product.id,
      specificationId: createdSpec.id,
      version,
      landingPageId: null,
      productLifecycleStatus: 'BLOCKED',
      stages,
      correlationId,
      failureReason: `Safety gate blocked the product: ${safety.reasons.join('; ')}`,
      qualityGates: quality.gates,
    };
  }
  if (safety.status === 'REVIEW_REQUIRED') {
    await tryTransition(product.id, 'REVIEW', 'pipeline: safety gate REVIEW_REQUIRED');
    stages.push(stage('safety', 'HALAL_SAFETY_VALIDATION', 'Halal/safety gate', 'HUMAN_REVIEW',
      `REVIEW_REQUIRED: ${safety.reasons.join('; ') || 'policy match'}. A qualified human must review; the pipeline stops here.`));
    return {
      ok: false,
      finalStatus: 'HUMAN_REVIEW',
      productId: product.id,
      specificationId: createdSpec.id,
      version,
      landingPageId: null,
      productLifecycleStatus: (await db.product.findUnique({ where: { id: product.id } }))?.status ?? 'UNKNOWN',
      stages,
      correlationId,
      failureReason: `Safety gate requires human review: ${safety.reasons.join('; ')}`,
      qualityGates: quality.gates,
    };
  }
  stages.push(stage('safety', 'HALAL_SAFETY_VALIDATION', 'Halal/safety gate', 'PASSED',
    `HALAL (automated screening control, policy ${safety.policyVersion}; not a religious ruling).`));

  // 8. Landing page (persisted; non-payment CTA).
  const landingFields = generateLandingPageFields({
    title: fields.title,
    problemSolved: fields.problemSolved,
    targetAudience: fields.targetAudience,
    coreValue: fields.coreValue,
    features: fields.features,
    deliverables: fields.deliverables,
    contentOutline: fields.contentOutline,
  });
  const landing = await db.productLandingPage.create({
    data: {
      productId: product.id,
      headline: landingFields.headline,
      problem: landingFields.problem,
      targetAudience: landingFields.targetAudience,
      valueProposition: landingFields.valueProposition,
      features: landingFields.features,
      whatsIncluded: landingFields.whatsIncluded,
      howItWorks: landingFields.howItWorks,
      faq: landingFields.faq,
      ctaType: landingFields.ctaType,
      ctaLabel: landingFields.ctaLabel,
      safetyNote: landingFields.safetyNote,
      status: landingFields.status,
      provenance: landingFields.provenance,
      correlationId,
    },
  });
  stages.push(stage('landing', 'LANDING_PAGE_GENERATION', 'Landing page generation', 'PASSED',
    'Landing page persisted; CTA is the non-payment "Coming Soon" placeholder.'));

  // 9. Finalize: TEST_PASS → READY_TO_DEPLOY; version row; spec READY.
  const passed = await tryTransition(product.id, 'TEST_PASS', 'pipeline: quality + safety passed');
  await db.productVersion.create({
    data: {
      productId: product.id,
      specificationId: createdSpec.id,
      version,
      changelog: JSON.stringify([
        { at: safety.checkedAt, change: `Spec v${version} generated (DETERMINISTIC/MOCKED), quality gate passed, safety screening ${safety.status}.` },
      ]),
      status: 'READY_FOR_PUBLISHING',
      provenance: 'MOCKED',
      generationMode: 'DETERMINISTIC',
      correlationId,
    },
  });
  await db.productSpecification.update({
    where: { id: createdSpec.id },
    data: { status: 'READY_FOR_PUBLISHING' },
  });
  stages.push(stage('package', 'PRODUCT_PACKAGE', 'Product package', passed ? 'PASSED' : 'FAILED',
    passed
      ? `Version v${version} recorded; product lifecycle READY_TO_DEPLOY (publishing is the next, not-yet-connected capability).`
      : 'Version recorded, but the guarded lifecycle refused TEST_PASS — final status reported honestly.'));

  const finalProduct = await db.product.findUnique({ where: { id: product.id } });
  const ok = passed && finalProduct?.status === 'READY_TO_DEPLOY';
  if (ok) {
    // Terminal creation record: the package is READY_FOR_PUBLISHING. This is
    // NOT a publication — publishing is a separate human-gated capability.
    stages.push(stage('final', 'READY_FOR_PUBLISHING', 'Ready for publishing', 'PASSED',
      `Spec v${version} READY_FOR_PUBLISHING; publishing capability remains NOT_CONFIGURED until an authorized provider is connected and a human approves.`));
  }
  logger.info('Product pipeline completed', {
    productId: product.id, specVersion: version, finalStatus: ok ? 'READY_FOR_PUBLISHING' : 'FAILED',
    correlationId, productStatus: finalProduct?.status,
  });

  return {
    ok,
    finalStatus: ok ? 'READY_FOR_PUBLISHING' : 'FAILED',
    productId: product.id,
    specificationId: createdSpec.id,
    version,
    landingPageId: landing.id,
    productLifecycleStatus: finalProduct?.status ?? 'UNKNOWN',
    stages,
    correlationId,
    failureReason: ok ? null : `Lifecycle machine did not confirm READY_TO_DEPLOY (status: ${finalProduct?.status}).`,
    qualityGates: quality.gates,
  };
}

function failureResult(
  productId: string | null,
  specId: string | null,
  finalStatus: ProductPipelineFinalStatus,
  version: number,
  reason: string,
  stages: ProductPipelineStage[],
  correlationId: string | null,
): ProductPipelineResult {
  logger.warn('Product pipeline refused', { reason: capText(reason, 200), correlationId });
  return {
    ok: false,
    finalStatus,
    productId: productId ?? '',
    specificationId: specId ?? '',
    version,
    landingPageId: null,
    productLifecycleStatus: 'UNKNOWN',
    stages,
    correlationId,
    failureReason: reason,
    qualityGates: [],
  };
}
