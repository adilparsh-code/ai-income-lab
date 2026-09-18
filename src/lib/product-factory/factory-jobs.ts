// Phase 5.3 — Product Factory job execution (deterministic, no AI).
//
// The seven factory job types run through the SAME job runner, idempotency,
// and halal gates as agent jobs. This module owns their business logic:
//
//   PRODUCT_CREATE   — guarded lifecycle transition SPEC_READY (gates apply)
//   PRODUCT_BUILD    — build contract (unavailable → UNAVAILABLE, never fake)
//   PRODUCT_TEST     — deterministic quality gates over the recorded spec
//   PRODUCT_DEPLOY   — deployment provider + human approval (NOT_CONNECTED
//                      without an authorized adapter; never fake-deploys)
//   PRODUCT_PUBLISH  — publishing contract + human approval (PUBLISHING_
//                      UNAVAILABLE; never fake-publishes)
//   REVENUE_SYNC     — recomputes product economics from recorded revenue
//   PRODUCT_ANALYZE  — deterministic growth classification for the product
//
// Everything is deterministic and DB/provider-driven: missing data is
// reported truthfully, nothing is fabricated, and the module never upgrades
// provenance. All provider actions require explicit human approval tokens in
// the payload; the token is never logged and only a hash is persisted.

import { db } from '@/lib/db';
import { resolveProductBuilder, runQualityGates } from './build-contract';
import {
  resolveDeploymentProvider,
  type DeploymentRecord,
} from './build-contract';
import { requestPublishing, type PublishableProductSpec } from '@/lib/publishing/contract';
import { applyProductTransition } from './lifecycle-service';
import { computeProductEconomics, attributeRevenueRow, type AttributableRevenueRow } from './economics';
import { classifyEvidence, recommendGrowthAction, type PerformanceEvidence } from '@/lib/business/growth-engine';
import { computeProductFunnel } from './events';
import { getProductAiCostAttribution } from '@/lib/ai/attribution';
import { logger } from '@/lib/server-log';

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

export interface FactoryJobOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'HUMAN_REVIEW' | 'DEGRADED';
  summary: Record<string, unknown> | null;
  error?: string;
}

export interface FactoryJobOptions {
  humanApprovalToken?: string;
  /** Test seam: skip durable build/deploy/asset persistence. */
  skipPersistence?: boolean;
}

/** Map a factory outcome onto the shared job statuses (halal dominates). */
export function mapFactoryOutcomeToStatus(outcome: FactoryJobOutcome, opportunityBlocked: boolean): FactoryJobOutcome['status'] {
  if (opportunityBlocked) return 'BLOCKED';
  return outcome.status;
}

// ---------------------------------------------------------------------------
// Shared product/spec loading (narrow structural DB surface)
// ---------------------------------------------------------------------------

export interface ProductRecord {
  id: string;
  status: string;
  name: string;
  type: string;
  targetAudience: string;
  notes: string;
  opportunityId: string | null;
  lifecycleHistory: string;
  opportunity?: { halalStatus: string } | null;
}

export interface FactoryDbSurface {
  product: {
    findUnique(args: { where: { id: string }; include?: { opportunity: { select: { halalStatus: true } } } }): Promise<ProductRecord | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  revenue: {
    findMany(args: { where: { productId: string } }): Promise<Array<{
      id: string; date: Date; revenueSource: string; grossRevenue: number;
      fees: number; netRevenue: number; productId: string | null; opportunityId: string | null;
    }>>;
  };
}

const defaultFactoryDb = db as unknown as FactoryDbSurface;

/** Test seam: inject a fake DB surface (hermetic tests, no real database). */
let dbOverride: FactoryDbSurface | null = null;
export function __setFactoryDbForTests(surface: FactoryDbSurface | null): void {
  dbOverride = surface;
}
function currentDb(): FactoryDbSurface {
  return dbOverride ?? defaultFactoryDb;
}

/** Load a product and parse its lifecycle history (bounded, tolerant). */
async function loadProduct(productId: string): Promise<ProductRecord | null> {
  const product = await currentDb().product.findUnique({
    where: { id: productId },
    include: { opportunity: { select: { halalStatus: true } } },
  });
  return product ?? null;
}

/**
 * Reconstruct the publishable spec from Product columns. The spec fields are
 * stored as JSON defaults by the lifecycle service; missing data yields an
 * incomplete spec that validation will flag (never invented).
 */
function specFromProduct(product: ProductRecord): PublishableProductSpec {
  const notes = product.notes ?? '';
  let mvp: PublishableProductSpec['mvpFeatures'] = [];
  let phases: PublishableProductSpec['buildPhases'] = [];
  let channels: string[] = [];
  try {
    const parsed = JSON.parse(notes) as {
      valueProposition?: string; problem?: string; mvpFeatures?: PublishableProductSpec['mvpFeatures'];
      buildPhases?: PublishableProductSpec['buildPhases']; distributionChannels?: string[];
      monetizationModel?: string; pricingHypothesis?: string; risks?: string[]; assumptions?: string[];
      evidence?: PublishableProductSpec['evidence']; evidenceProvenance?: PublishableProductSpec['evidenceProvenance'];
    };
    mvp = Array.isArray(parsed.mvpFeatures) ? parsed.mvpFeatures : [];
    phases = Array.isArray(parsed.buildPhases) ? parsed.buildPhases : [];
    channels = Array.isArray(parsed.distributionChannels) ? parsed.distributionChannels : [];
    return {
      productType: product.type,
      name: product.name,
      targetAudience: product.targetAudience,
      problem: typeof parsed.problem === 'string' && parsed.problem.trim() ? parsed.problem : product.notes.slice(0, 200),
      valueProposition: typeof parsed.valueProposition === 'string' ? parsed.valueProposition : '',
      mvpFeatures: mvp,
      buildPhases: phases,
      monetizationModel: typeof parsed.monetizationModel === 'string' ? parsed.monetizationModel : 'ONE_TIME_PURCHASE',
      pricingHypothesis: typeof parsed.pricingHypothesis === 'string' ? parsed.pricingHypothesis : '',
      distributionChannels: channels,
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      evidenceProvenance: parsed.evidenceProvenance ?? 'MOCKED',
    };
  } catch {
    // Non-JSON notes: derive a minimal, honestly-labeled spec stub.
    return {
      productType: product.type,
      name: product.name,
      targetAudience: product.targetAudience,
      problem: notes.slice(0, 200),
      valueProposition: '',
      mvpFeatures: [],
      buildPhases: [],
      monetizationModel: 'ONE_TIME_PURCHASE',
      pricingHypothesis: '',
      distributionChannels: [],
      risks: [],
      assumptions: [],
      evidence: [],
      evidenceProvenance: 'MOCKED',
    };
  }
}

// ---------------------------------------------------------------------------
// Per-job execution
// ---------------------------------------------------------------------------

export async function executeFactoryJob(
  jobType: string,
  payload: { productId?: string; humanApprovalToken?: string; channel?: string; [key: string]: unknown },
  options: FactoryJobOptions = {},
): Promise<FactoryJobOutcome> {
  const productId = typeof payload.productId === 'string' ? payload.productId : '';
  if (!productId) {
    return { status: 'FAILED', summary: null, error: 'productId is required for factory jobs.' };
  }

  const product = await loadProduct(productId);
  if (!product) {
    return { status: 'FAILED', summary: null, error: `Product ${productId} not found.` };
  }

  const halalStatus = product.opportunity?.halalStatus ?? 'HALAL';
  if (halalStatus === 'NOT_ALLOWED') {
    return { status: 'BLOCKED', summary: null, error: 'Blocked: opportunity halalStatus is NOT_ALLOWED. No factory action performed.' };
  }
  if (halalStatus === 'REVIEW_REQUIRED') {
    return { status: 'HUMAN_REVIEW', summary: null, error: 'Paused: opportunity halalStatus is REVIEW_REQUIRED. A human must review before factory actions.' };
  }

  const token = options.humanApprovalToken ?? (typeof payload.humanApprovalToken === 'string' ? payload.humanApprovalToken : undefined);

  switch (jobType) {
    case 'PRODUCT_CREATE':
      return productCreate(product, token);
    case 'PRODUCT_BUILD':
      return productBuild(product);
    case 'PRODUCT_TEST':
      return productTest(product);
    case 'PRODUCT_DEPLOY':
      return productDeploy(product, token);
    case 'PRODUCT_PUBLISH':
      return productPublish(product, token);
    case 'REVENUE_SYNC':
      return revenueSync(product);
    case 'PRODUCT_ANALYZE':
      return productAnalyze(product);
    default:
      return { status: 'FAILED', summary: null, error: `Unknown factory job type: ${jobType}` };
  }
}

/** PRODUCT_CREATE: mark spec ready through the guarded lifecycle. */
async function productCreate(product: ProductRecord, token?: string): Promise<FactoryJobOutcome> {
  const decision = await applyProductTransition({
    productId: product.id,
    transition: 'SPEC_READY',
    evidence: token ? { humanApprovalToken: token } : undefined,
    halalStatus: (product.opportunity?.halalStatus as 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED') ?? 'HALAL',
  });
  return {
    status: decision.ok ? 'SUCCEEDED' : 'FAILED',
    summary: { transition: decision.record, reason: decision.reason },
    ...(decision.ok ? {} : { error: decision.reason }),
  };
}

/** PRODUCT_BUILD: through the build contract (unavailable stays unavailable). */
async function productBuild(product: ProductRecord): Promise<FactoryJobOutcome> {
  const builder = resolveProductBuilder();
  if (!builder) {
    return {
      status: 'DEGRADED',
      summary: {
        buildStatus: 'UNAVAILABLE',
        message: 'No product builder is connected; nothing was built. '
          + 'The build contract and quality gates are ready for a future sandboxed builder adapter.',
      },
    };
  }
  const spec = specFromProduct(product);
  const validation = builder.validate(spec);
  if (!validation.valid) {
    return { status: 'FAILED', summary: { errors: validation.errors }, error: 'Spec failed build validation.' };
  }
  const result = await builder.build(spec);
  return { status: result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'DEGRADED', summary: { build: { status: result.status, artifactRef: result.artifactRef, version: result.version } } };
}

/** PRODUCT_TEST: deterministic quality gates over the recorded spec. */
async function productTest(product: ProductRecord): Promise<FactoryJobOutcome> {
  const spec = specFromProduct(product);
  const gates = runQualityGates(spec);
  const failed = gates.filter((g) => !g.passed);
  return {
    status: failed.length === 0 ? 'SUCCEEDED' : 'DEGRADED',
    summary: {
      qualityGates: gates,
      passed: gates.length - failed.length,
      total: gates.length,
      message: failed.length > 0
        ? `${failed.length} quality gate(s) failed; the product cannot proceed to deploy until fixed.`
        : 'All quality gates passed.',
    },
  };
}

/** PRODUCT_DEPLOY: provider + human approval. Not connected → honest record. */
async function productDeploy(product: ProductRecord, token?: string): Promise<FactoryJobOutcome> {
  const provider = resolveDeploymentProvider();

  if (!token?.trim()) {
    return {
      status: 'HUMAN_REVIEW',
      summary: {
        message: 'Deployment requires an explicit human approval token. Nothing was deployed.',
      },
    };
  }

  // The unavailable sentinel provider short-circuits to deploy(): its record
  // (DEPLOYMENT_NOT_CONNECTED, no ids) is the honest outcome. Structural
  // validation only applies to real adapters.
  let record: DeploymentRecord;
  if (provider.id === 'unavailable') {
    record = await provider.deploy({ target: 'NEXTJS', artifactRef: product.id }, token);
  } else {
    const validation = provider.validate({ target: 'NEXTJS', artifactRef: product.id });
    if (!validation.valid) {
      return {
        status: 'FAILED',
        summary: { errors: validation.errors },
        error: 'Deployment target failed provider validation; nothing was deployed.',
      };
    }
    record = await provider.deploy({ target: 'NEXTJS', artifactRef: product.id }, token);
  }
  return {
    status: record.status === 'DEPLOYED' ? 'SUCCEEDED' : record.status === 'DEPLOYMENT_NOT_CONNECTED' ? 'DEGRADED' : 'FAILED',
    summary: {
      deployment: {
        status: record.status,
        providerId: record.providerId,
        deploymentId: record.deploymentId,
        url: record.url,
      },
      message: record.status === 'DEPLOYMENT_NOT_CONNECTED'
        ? 'No deployment provider is connected; nothing was deployed. The approval gate worked: a token alone cannot deploy without an authorized adapter.'
        : record.errors[0] ?? '',
    },
    ...(record.errors.length > 0 && record.status !== 'DEPLOYED' ? { error: record.errors[0] } : {}),
  };
}

/** PRODUCT_PUBLISH: publishing contract + human approval. */
async function productPublish(product: ProductRecord, token?: string): Promise<FactoryJobOutcome> {
  const spec = specFromProduct(product);

  if (!token?.trim()) {
    return {
      status: 'HUMAN_REVIEW',
      summary: { message: 'Publication requires an explicit human approval token. Nothing was published.' },
    };
  }

  const response = requestPublishing({ channel: 'DIGITAL_PRODUCT', spec, humanApprovalToken: token });
  return {
    status: response.status === 'PUBLISHING_UNAVAILABLE' ? 'DEGRADED' : response.publication?.published ? 'SUCCEEDED' : 'FAILED',
    summary: {
      publishing: {
        status: response.status,
        providerId: response.providerId,
        published: response.publication?.published ?? false,
      },
      message: 'Publishing boundary consulted; publication requires an authorized adapter and explicit human approval.',
    },
    ...(response.errors.length > 0 ? { error: response.errors[0] } : {}),
  };
}

/** REVENUE_SYNC: recomputes economics from recorded revenue + AI attribution. */
async function revenueSync(product: ProductRecord): Promise<FactoryJobOutcome> {
  const rows = await currentDb().revenue.findMany({ where: { productId: product.id } });
  const attributable = rows.map((row) => attributeRevenueRow(row as AttributableRevenueRow));
  const gross = rows.reduce((sum, r) => sum + r.grossRevenue, 0);
  const fees = rows.reduce((sum, r) => sum + r.fees, 0);
  const net = rows.reduce((sum, r) => sum + r.netRevenue, 0);

  // Per-product AI cost attribution (Phase 5.4): ESTIMATED token-based sums
  // from the single AgentLog ledger — one row per execution, no double count.
  const aiAttribution = await getProductAiCostAttribution(product.id);

  const economics = computeProductEconomics({
    grossRevenueUsd: rows.length > 0 ? gross : null,
    feesUsd: rows.length > 0 ? fees : null,
    netRevenueUsd: rows.length > 0 ? net : null,
    aiCostUsd: aiAttribution.executions > 0 ? aiAttribution.aiTotalCostUsd : null,
    buildCostUsd: null,
    deploymentCostUsd: null,
    publishingCostUsd: null,
    marketingCostUsd: rows.length > 0 ? rows.reduce((sum, r) => sum + (r.netRevenue - r.grossRevenue + r.fees), 0) : null,
  });

  // Persist the economics summary onto the product (bounded JSON).
  await currentDb().product.update({
    where: { id: product.id },
    data: {
      notes: JSON.stringify({
        ...safeNotes(product.notes),
        lastEconomics: {
          computedAt: new Date().toISOString(),
          revenueRows: rows.length,
          grossRevenueUsd: Number(gross.toFixed(2)),
          feesUsd: Number(fees.toFixed(2)),
          netRevenueUsd: Number(net.toFixed(2)),
          profitabilityClaim: economics.profitabilityClaim,
          unknownSourceCount: attributable.filter((a) => a.source === 'UNKNOWN_SOURCE').length,
          aiCostBasis: 'ESTIMATED_TOKEN_BASED',
          aiCostUsd: Number(aiAttribution.aiTotalCostUsd.toFixed(6)),
          aiExecutions: aiAttribution.executions,
        },
      }),
    },
  });

  return {
    status: 'SUCCEEDED',
    summary: {
      revenueRows: rows.length,
      grossRevenueUsd: Number(gross.toFixed(2)),
      feesUsd: Number(fees.toFixed(2)),
      netRevenueUsd: Number(net.toFixed(2)),
      profitabilityClaim: economics.profitabilityClaim,
      claimBasis: economics.claimBasis,
      aiCostUsd: Number(aiAttribution.aiTotalCostUsd.toFixed(6)),
      aiCostBasis: 'ESTIMATED_TOKEN_BASED',
      aiExecutions: aiAttribution.executions,
    },
  };
}

/** PRODUCT_ANALYZE: deterministic growth classification for this product. */
async function productAnalyze(product: ProductRecord): Promise<FactoryJobOutcome> {
  const rows = await currentDb().revenue.findMany({ where: { productId: product.id } });
  const revenue = rows.reduce((sum, r) => sum + r.grossRevenue, 0);
  const net = rows.reduce((sum, r) => sum + r.netRevenue, 0);
  const costs = rows.reduce((sum, r) => sum + (r.grossRevenue - r.netRevenue), 0);

  // Visitors come ONLY from recorded ProductEvent rows (Phase 5.4 ingestion
  // foundation) — never from a placeholder or an AI inference.
  let visitors = 0;
  let visitorEvidenceStatus = 'NO_EVENTS_RECORDED';
  try {
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 86_400_000);
    const funnel = await computeProductFunnel(product.id, { start: windowStart, end: windowEnd });
    visitors = funnel.visitors;
    visitorEvidenceStatus = funnel.evidenceStatus;
  } catch {
    // Event storage unavailable: honest zero, never a fabricated sample.
  }

  const evidence: PerformanceEvidence = {
    ageDays: rows.length > 0 ? Math.max(1, Math.floor((Date.now() - rows[rows.length - 1].date.getTime()) / 86_400_000)) : 0,
    visitors,
    revenue,
    costs,
    conversions: rows.length,
    experimentDecision: null,
    manuallyPaused: product.status === 'PAUSED',
  };

  const classification = classifyEvidence(evidence);
  const recommendation = recommendGrowthAction({
    revenue: {
      gross: revenue,
      net,
      contributionProfit: net - costs,
      recordCount: rows.length,
    },
    products: [{ id: product.id, label: product.name, hasProduct: true, evidence }],
    experiments: [],
    activeOpportunityCount: product.opportunityId ? 1 : 0,
    estimatedAiCostUsd: 0,
  });

  logger.info('Factory PRODUCT_ANALYZE completed', { productId: product.id, state: classification.state, action: recommendation.type });

  return {
    status: 'SUCCEEDED',
    summary: {
      evidenceState: classification.state,
      reasons: classification.reasons.slice(0, 5),
      recommendedAction: recommendation.type,
      dataStatus: recommendation.dataStatus,
      actionReason: recommendation.reason.slice(0, 300),
      recordedVisitors: visitors,
      visitorEvidenceStatus,
      message: 'Deterministic growth classification from recorded revenue rows and recorded product events only. Nothing is predicted.',
    },
  };
}

function safeNotes(notes: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(notes);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
