// ============================================================================
// PHASE 11.3 — BOUNDED MICRO-SERVICE CATALOG (pure)
// ============================================================================
// Micro-services are first-class income: SMALL, BOUNDED, REPEATABLE units of
// work. Each catalogue entry has a defined scope, defined deliverables, an
// effort estimate, a price band, a revision limit, and a QA gate. There is no
// "unlimited generic autonomous work" here — every entry is a fixed shape.
//
// Pure module: no DB, no network, no AI provider.
//
// The catalogue is deliberately boring: bounded catalogs are what make
// micro-services safe to repeat, price honestly, and QA deterministically.
// ============================================================================

// ---------------------------------------------------------------------------
// Bounded service kinds
// ---------------------------------------------------------------------------

export const MICRO_SERVICE_KINDS = [
  'CUSTOM_WORKSHEET',
  'CUSTOM_ACTIVITY_PACK',
  'CUSTOM_COLORING_PACK',
  'CUSTOM_DESIGN',
  'CUSTOM_REPORT',
  'DOCUMENT_FORMATTING',
  'PRESENTATION',
  'SPREADSHEET',
  'RESEARCH',
  'SMALL_AUTOMATION',
  'SMALL_WEBSITE',
  'EDUCATIONAL_MATERIAL',
  'OTHER_LEGITIMATE_SERVICE',
] as const;
export type MicroServiceKind = (typeof MICRO_SERVICE_KINDS)[number];

export function isMicroServiceKind(value: unknown): value is MicroServiceKind {
  return typeof value === 'string' && (MICRO_SERVICE_KINDS as readonly string[]).includes(value);
}

/** Bounded deliverable kinds a micro-service may produce. */
export const DELIVERABLE_KINDS = [
  'DOCUMENT',
  'WORKSHEET',
  'SPREADSHEET',
  'SLIDES',
  'DESIGN_ASSET',
  'WEB_PAGE',
  'REPORT',
  'AUTOMATION',
  'RESEARCH_NOTE',
  'SOURCE_PACKAGE',
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return typeof value === 'string' && (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export interface MicroServiceDefinition {
  kind: MicroServiceKind;
  label: string;
  /** Bounded scope statement — what the service IS, and implicitly is not. */
  scope: string;
  deliverables: { title: string; kind: DeliverableKind; description: string }[];
  /** Bounded effort in hours (typical, honest — not a market claim). */
  typicalEffortHours: number;
  maxEffortHours: number;
  /** Price band in USD; the ask must sit inside the band to be ACTIVE. */
  minPriceUsd: number;
  maxPriceUsd: number;
  /** Finite revisions, always small for micro-services. */
  defaultRevisionLimit: number;
  /** QA checks that must pass before READY_FOR_DELIVERY. */
  qaChecks: string[];
}

/**
 * The catalogue. Each entry is deliberately narrow: a micro-service that could
 * absorb arbitrary scope is a client service pretending to be small.
 */
export const MICRO_SERVICE_CATALOGUE: readonly MicroServiceDefinition[] = [
  {
    kind: 'CUSTOM_WORKSHEET',
    label: 'Custom worksheet',
    scope: 'One printable worksheet (up to 3 pages) on a topic supplied by the client. No lesson plans, no answer keys unless separately scoped.',
    deliverables: [{ title: 'Worksheet (printable)', kind: 'WORKSHEET', description: 'A single printable worksheet meeting the stated topic and age/level requirement.' }],
    typicalEffortHours: 2,
    maxEffortHours: 6,
    minPriceUsd: 15,
    maxPriceUsd: 150,
    defaultRevisionLimit: 1,
    qaChecks: ['Prints cleanly at A4/Letter', 'No spelling or truncation errors', 'Matches the stated topic and level'],
  },
  {
    kind: 'CUSTOM_ACTIVITY_PACK',
    label: 'Custom activity pack',
    scope: 'A pack of up to 10 related printable activity sheets on one theme. Additional themes are a change request.',
    deliverables: [{ title: 'Activity pack (up to 10 sheets)', kind: 'DOCUMENT', description: 'Consistently formatted activity sheets sharing one theme.' }],
    typicalEffortHours: 6,
    maxEffortHours: 20,
    minPriceUsd: 40,
    maxPriceUsd: 400,
    defaultRevisionLimit: 1,
    qaChecks: ['All sheets share one visual system', 'Every sheet is usable standalone', 'Print range verified'],
  },
  {
    kind: 'CUSTOM_COLORING_PACK',
    label: 'Custom coloring pack',
    scope: 'Up to 8 line-art coloring pages suitable for printing at home. Clip-art from unlicensed sources is never used.',
    deliverables: [{ title: 'Coloring pages (up to 8)', kind: 'DESIGN_ASSET', description: 'Original or properly licensed line art, print-ready.' }],
    typicalEffortHours: 5,
    maxEffortHours: 18,
    minPriceUsd: 35,
    maxPriceUsd: 350,
    defaultRevisionLimit: 1,
    qaChecks: ['Lines are closed and printable', 'No unlicensed third-party artwork', 'Consistent page size'],
  },
  {
    kind: 'CUSTOM_DESIGN',
    label: 'Custom design asset',
    scope: 'A single bounded design asset (poster, banner, or icon set up to 10 icons) from a client-supplied brief.',
    deliverables: [{ title: 'Design asset (source + export)', kind: 'DESIGN_ASSET', description: 'Source file plus web/print exports.' }],
    typicalEffortHours: 4,
    maxEffortHours: 16,
    minPriceUsd: 30,
    maxPriceUsd: 500,
    defaultRevisionLimit: 2,
    qaChecks: ['Exports at the agreed dimensions', 'Fonts are licensed or substituted', 'Contrast meets readability minimums'],
  },
  {
    kind: 'CUSTOM_REPORT',
    label: 'Custom report',
    scope: 'A written report of up to 10 pages summarizing client-supplied material. Original research is separately scoped.',
    deliverables: [{ title: 'Report (PDF + source)', kind: 'REPORT', description: 'Structured report with a table of contents and cited inputs.' }],
    typicalEffortHours: 6,
    maxEffortHours: 25,
    minPriceUsd: 50,
    maxPriceUsd: 800,
    defaultRevisionLimit: 2,
    qaChecks: ['Every claim traces to supplied material', 'No fabricated statistics', 'Table of contents is accurate'],
  },
  {
    kind: 'DOCUMENT_FORMATTING',
    label: 'Document formatting',
    scope: 'Formatting an existing client-supplied document (styles, headings, tables, front matter). Content is not written or rewritten.',
    deliverables: [{ title: 'Formatted document', kind: 'DOCUMENT', description: 'Consistently styled document from the supplied content.' }],
    typicalEffortHours: 2,
    maxEffortHours: 8,
    minPriceUsd: 20,
    maxPriceUsd: 200,
    defaultRevisionLimit: 1,
    qaChecks: ['Styles are applied consistently', 'No client content is lost', 'Heading hierarchy is correct'],
  },
  {
    kind: 'PRESENTATION',
    label: 'Presentation',
    scope: 'Up to 15 slides built from client-supplied content. Original research, data analysis, or scripting are out of scope.',
    deliverables: [{ title: 'Slide deck', kind: 'SLIDES', description: 'Formatted deck from supplied content, speaker-notes free.' }],
    typicalEffortHours: 4,
    maxEffortHours: 15,
    minPriceUsd: 35,
    maxPriceUsd: 450,
    defaultRevisionLimit: 2,
    qaChecks: ['Slides do not overflow', 'Consistent master layout', 'No unsupported fonts'],
  },
  {
    kind: 'SPREADSHEET',
    label: 'Spreadsheet',
    scope: 'A spreadsheet implementing a clearly specified calculation or tracker, with documented formulas. No macro development.',
    deliverables: [{ title: 'Spreadsheet with documented formulas', kind: 'SPREADSHEET', description: 'Workbook implementing the specified logic, formulas documented.' }],
    typicalEffortHours: 3,
    maxEffortHours: 12,
    minPriceUsd: 25,
    maxPriceUsd: 350,
    defaultRevisionLimit: 1,
    qaChecks: ['Formulas recalculate without errors', 'Input cells are clearly marked', 'No hard-coded values in calculation cells'],
  },
  {
    kind: 'RESEARCH',
    label: 'Small research task',
    scope: 'A single, clearly bounded research question answered from public sources, with every source cited and retrieved. No scraping of private or personal data.',
    deliverables: [{ title: 'Research note with citations', kind: 'RESEARCH_NOTE', description: 'A bounded answer with full source citations.' }],
    typicalEffortHours: 3,
    maxEffortHours: 12,
    minPriceUsd: 30,
    maxPriceUsd: 400,
    defaultRevisionLimit: 1,
    qaChecks: ['Every claim has a citation', 'No personal/private data collected', 'Sources were actually retrieved'],
  },
  {
    kind: 'SMALL_AUTOMATION',
    label: 'Small automation',
    scope: 'One documented automation between two named tools, reproducible from a written procedure. High-impact or irreversible actions are excluded.',
    deliverables: [{ title: 'Automation + written procedure', kind: 'AUTOMATION', description: 'A reproducible procedure plus a written runbook.' }],
    typicalEffortHours: 4,
    maxEffortHours: 18,
    minPriceUsd: 50,
    maxPriceUsd: 900,
    defaultRevisionLimit: 2,
    qaChecks: ['No irreversible or high-impact actions', 'Runbook is reproducible by a third party', 'Credentials are never embedded in the deliverable'],
  },
  {
    kind: 'SMALL_WEBSITE',
    label: 'Small website or landing page',
    scope: 'Up to five static pages with no backend, no accounts, and no payments. Dynamic features are a separate engagement.',
    deliverables: [{ title: 'Static site (up to 5 pages)', kind: 'WEB_PAGE', description: 'Static pages with client-supplied content, no backend.' }],
    typicalEffortHours: 8,
    maxEffortHours: 30,
    minPriceUsd: 150,
    maxPriceUsd: 2500,
    defaultRevisionLimit: 2,
    qaChecks: ['No backend or account system', 'Valid HTML and no console errors', 'Mobile layout verified'],
  },
  {
    kind: 'EDUCATIONAL_MATERIAL',
    label: 'Educational material',
    scope: 'A bounded educational resource (lesson handout, worksheet set, or short study guide) on a client-stated topic and level.',
    deliverables: [{ title: 'Educational resource', kind: 'DOCUMENT', description: 'Level-appropriate material aligned to the stated learning goal.' }],
    typicalEffortHours: 4,
    maxEffortHours: 16,
    minPriceUsd: 35,
    maxPriceUsd: 450,
    defaultRevisionLimit: 1,
    qaChecks: ['Content matches the stated level', 'No copyrighted source material reproduced', 'Exercises have answer keys where applicable'],
  },
  {
    kind: 'OTHER_LEGITIMATE_SERVICE',
    label: 'Other legitimate service',
    scope: 'A legitimate service defined explicitly in an approved proposal version. Because it is unbounded by catalogue, it requires an explicit approved scope contract.',
    deliverables: [{ title: 'Scoped deliverable', kind: 'DOCUMENT', description: 'Defined by the approved proposal version scope contract.' }],
    typicalEffortHours: 4,
    maxEffortHours: 40,
    minPriceUsd: 25,
    maxPriceUsd: 5000,
    defaultRevisionLimit: 2,
    qaChecks: ['Scope matches the approved proposal version', 'QA checklist recorded', 'No out-of-scope work performed'],
  },
] as const;

export function findMicroService(kind: unknown): MicroServiceDefinition | null {
  if (!isMicroServiceKind(kind)) return null;
  return MICRO_SERVICE_CATALOGUE.find((d) => d.kind === kind) ?? null;
}

// ---------------------------------------------------------------------------
// Packaging / bounds validation
// ---------------------------------------------------------------------------

export type MicroServiceValidation =
  | { ok: true; definition: MicroServiceDefinition; effortHours: number; revisionLimit: number }
  | { ok: false; reason: string };

/**
 * Validate a micro-service package against its catalogue definition. A package
 * outside the declared bounds is REFUSED, not silently clamped: an honest
 * refusal is what keeps the micro-service promise repeatable.
 */
export function validateMicroServicePackage(input: {
  kind: unknown;
  estimatedEffortHours?: unknown;
  revisionLimit?: unknown;
}): MicroServiceValidation {
  const definition = findMicroService(input.kind);
  if (!definition) {
    return { ok: false, reason: `kind must be one of: ${MICRO_SERVICE_KINDS.join(', ')}.` };
  }
  const effort = input.estimatedEffortHours === undefined || input.estimatedEffortHours === null
    ? definition.typicalEffortHours
    : input.estimatedEffortHours;
  if (typeof effort !== 'number' || !Number.isFinite(effort) || effort <= 0 || effort > definition.maxEffortHours) {
    return {
      ok: false,
      reason: `${definition.label}: estimatedEffortHours must be greater than 0 and at most ${definition.maxEffortHours}.`,
    };
  }
  const revisionLimit = input.revisionLimit === undefined || input.revisionLimit === null
    ? definition.defaultRevisionLimit
    : input.revisionLimit;
  if (typeof revisionLimit !== 'number' || !Number.isInteger(revisionLimit) || revisionLimit < 0 || revisionLimit > 3) {
    return {
      ok: false,
      reason: `${definition.label}: revisionLimit must be an integer between 0 and 3. Micro-service revisions are finite.`,
    };
  }
  return { ok: true, definition, effortHours: effort, revisionLimit };
}

/**
 * Price band check. The catalogue band is a BOUND on what this business will
 * quote for a bounded micro-service — not a market claim about competitors.
 */
export function isPriceWithinBand(definition: MicroServiceDefinition, price: number): boolean {
  return Number.isFinite(price) && price >= definition.minPriceUsd && price <= definition.maxPriceUsd;
}

/**
 * Deterministic QA evaluation for a micro-service deliverable. QA is DISTINCT
 * from generation: a generated artifact is DRAFT until this returns passed.
 * There is no AI judgement here — checks are explicit and caller-reported, so
 * an unverifiable check fails closed rather than being assumed.
 */
export interface QaCheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

export type QaVerdict =
  | { passed: true; checks: QaCheckResult[] }
  | { passed: false; failed: QaCheckResult[]; reason: string; checks?: QaCheckResult[] };

export function evaluateMicroServiceQa(
  definition: MicroServiceDefinition,
  reported: readonly { check: string; passed: unknown; detail?: unknown }[],
): QaVerdict {
  const byCheck = new Map<string, { passed: unknown; detail: unknown }>();
  for (const entry of reported.slice(0, 32)) {
    if (typeof entry?.check !== 'string') continue;
    byCheck.set(entry.check, { passed: entry.passed, detail: entry.detail });
  }
  const checks: QaCheckResult[] = definition.qaChecks.map((check) => {
    const hit = byCheck.get(check);
    // Fail closed: an unreported check is NOT a passed check.
    const passed = hit?.passed === true;
    const detail = passed
      ? (typeof hit?.detail === 'string' ? hit.detail.slice(0, 300) : 'Reported as passed.')
      : hit === undefined
        ? 'Not reported — treated as NOT passed (QA fails closed).'
        : (typeof hit.detail === 'string' ? hit.detail.slice(0, 300) : 'Reported as failed.');
    return { check, passed, detail };
  });
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    return {
      passed: false,
      failed,
      checks,
      reason: `${failed.length} QA check(s) did not pass; the deliverable cannot be released as final.`,
    };
  }
  return { passed: true, checks };
}