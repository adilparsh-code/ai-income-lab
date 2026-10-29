// Phase 5.3 — Product lifecycle service (server-only).
//
// The ONLY module that mutates Product.status. Every change goes through the
// pure lifecycle guard (assertValidProductTransition) so halal gates, human
// approval tokens, and real-provider evidence rules are enforced identically
// everywhere. Builds, deployments, and assets are recorded on their additive
// tables; the deployment record stores only a hash hint of the approval token
// (never the token itself).
//
// Dependency injection: DB access goes through a narrow structural interface;
// tests inject fakes (hermetic, no DB).

import { db } from '@/lib/db';
import { logger } from '@/lib/server-log';
import {
  APPROVAL_REQUIRED_TRANSITIONS,
  precheckTransitionBeforeApproval,
  assertValidProductTransition,
  normalizeStatus,
  type LifecycleDecision,
  type ProductTransition,
  type TransitionEvidence,
} from './lifecycle';
import type { BuildResult } from './build-contract';
import { consumeApproval, approvalScopeHash, productApprovalScope } from '@/lib/security/approvals';
import { isVerifiedApproval, type VerifiedApproval } from '@/lib/security/approvals-core';

// ---------------------------------------------------------------------------
// Injectable DB surface
// ---------------------------------------------------------------------------

export interface LifecycleProductRow {
  id: string;
  status: string;
  opportunityId: string | null;
  lifecycleHistory?: string;
  opportunity?: { halalStatus: string } | null;
}

export interface LifecycleDb {
  product: {
    findUnique(args: { where: { id: string }; include?: { opportunity: { select: { halalStatus: true } } } }): Promise<LifecycleProductRow | null>;
    update(args: { where: { id: string }; data: { status: string; lifecycleHistory?: string } }): Promise<unknown>;
  };
  productBuild: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  productDeployment: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  productAsset: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

const defaultDb = db as unknown as LifecycleDb;

// ---------------------------------------------------------------------------
// Guarded status transition (durable)
// ---------------------------------------------------------------------------

export interface ApplyTransitionInput {
  productId: string;
  transition: ProductTransition;
  evidence?: Omit<TransitionEvidence, 'approval'>;
  /**
   * Opaque, server-issued, single-use approval token (POST /api/approvals).
   * Consumed here — bound to this exact product and its current status — only
   * AFTER every non-approval gate has passed, so refused transitions never burn it.
   */
  approvalToken?: string;
  /** Test seam: override halal status (otherwise read from the opportunity). */
  halalStatus?: 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';
}

export interface ApplyTransitionResult extends LifecycleDecision {
  productId: string;
}

export async function applyProductTransition(
  input: ApplyTransitionInput,
  inject?: { db?: LifecycleDb; consume?: typeof consumeApproval },
): Promise<ApplyTransitionResult> {
  const store = inject?.db ?? defaultDb;
  const product = await store.product.findUnique({
    where: { id: input.productId },
    include: { opportunity: { select: { halalStatus: true } } },
  });

  if (!product) {
    return {
      ok: false,
      nextStatus: 'IDEA',
      productId: input.productId,
      reason: `Product ${input.productId} not found; no transition applied.`,
      record: {
        from: 'unknown', to: 'IDEA', transition: input.transition,
        at: new Date().toISOString(), reason: 'Product not found.',
      },
    };
  }

  const halalStatus = input.halalStatus
    ?? (product.opportunity?.halalStatus as LifecycleGuardHalal | undefined)
    ?? 'HALAL';

  const guardBase = {
    halalStatus,
    currentStatus: normalizeStatus(product.status),
    transition: input.transition,
  };
  let approval: VerifiedApproval | undefined;
  if (APPROVAL_REQUIRED_TRANSITIONS.includes(input.transition)
    && precheckTransitionBeforeApproval({ ...guardBase, evidence: input.evidence }).ok) {
    const consumed = await (inject?.consume ?? consumeApproval)(input.approvalToken, {
      action: input.transition === 'DEPLOY' ? 'LIFECYCLE_DEPLOY' : 'LIFECYCLE_PUBLISH',
      subjectId: input.productId,
      scopeHash: approvalScopeHash(productApprovalScope({ id: input.productId, status: product.status })),
      surface: 'lifecycle:applyProductTransition',
    });
    if (consumed.ok) approval = consumed.approval;
  }

  const decision = assertValidProductTransition({
    ...guardBase,
    evidence: { ...input.evidence, ...(approval ? { approval } : {}) },
  });

  if (decision.ok) {
    const history = parseHistory(product.lifecycleHistory);
    history.push(decision.record);
    await store.product.update({
      where: { id: input.productId },
      data: {
        status: decision.nextStatus,
        lifecycleHistory: JSON.stringify(history.slice(-50)), // bounded audit trail
      },
    });
    logger.info('Product lifecycle transition applied', {
      productId: input.productId,
      transition: input.transition,
      from: decision.record.from,
      to: decision.nextStatus,
    });
  } else {
    logger.warn('Product lifecycle transition rejected', {
      productId: input.productId,
      transition: input.transition,
      reason: decision.reason,
    });
  }

  return { ...decision, productId: input.productId };
}

type LifecycleGuardHalal = 'HALAL' | 'REVIEW_REQUIRED' | 'NOT_ALLOWED';

function parseHistory(raw: string | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-49) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Build / deployment / asset recording
// ---------------------------------------------------------------------------

export async function recordProductBuild(
  productId: string,
  result: BuildResult,
  correlationId?: string,
  inject?: { db?: LifecycleDb },
): Promise<string | null> {
  const store = inject?.db ?? defaultDb;
  try {
    const row = await store.productBuild.create({
      data: {
        productId,
        status: result.status,
        version: result.version,
        artifactRef: result.artifactRef,
        tests: JSON.stringify(result.tests ?? {}),
        logSummary: (result.logSummary ?? '').slice(0, 2000),
        qualityGates: JSON.stringify(result.qualityGates),
        sandboxed: result.sandboxed,
        correlationId: correlationId ?? null,
      },
    });
    return row.id;
  } catch (error) {
    logger.error('ProductBuild persistence failed; build result still returned', error);
    return null;
  }
}

export async function recordProductDeployment(
  productId: string,
  record: {
    status: string;
    providerId: string | null;
    deploymentId: string | null;
    url: string | null;
    version: string | null;
    errors: string[];
    timestamp: string;
  },
  options: { approval?: VerifiedApproval; correlationId?: string },
  inject?: { db?: LifecycleDb },
): Promise<string | null> {
  const store = inject?.db ?? defaultDb;
  try {
    const row = await store.productDeployment.create({
      data: {
        productId,
        status: record.status,
        providerId: record.providerId,
        deploymentId: record.deploymentId,
        url: record.url,
        version: record.version,
        errors: JSON.stringify(record.errors.slice(0, 10)),
        approved: isVerifiedApproval(options.approval),
        // Column kept for compatibility: now stores the consumed ApprovalGrant id
        // (an audit link), never any token material.
        approvalTokenHash: isVerifiedApproval(options.approval) ? options.approval.grantId : '',
        correlationId: options.correlationId ?? null,
      },
    });
    return row.id;
  } catch (error) {
    logger.error('ProductDeployment persistence failed; record still returned', error);
    return null;
  }
}

export async function recordProductAsset(
  productId: string,
  asset: {
    assetType: string;
    source: string;
    provenance: string;
    rightsStatus: string;
    publicationStatus: string;
    origin?: string;
  },
  inject?: { db?: LifecycleDb },
): Promise<string | null> {
  const store = inject?.db ?? defaultDb;
  try {
    const row = await store.productAsset.create({
      data: {
        productId,
        assetType: asset.assetType,
        source: asset.source,
        provenance: asset.provenance,
        rightsStatus: asset.rightsStatus,
        publicationStatus: asset.publicationStatus,
        origin: (asset.origin ?? '').slice(0, 500),
      },
    });
    return row.id;
  } catch (error) {
    logger.error('ProductAsset persistence failed; record still returned', error);
    return null;
  }
}
