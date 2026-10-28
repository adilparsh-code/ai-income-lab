// ============================================================================
// HUMAN APPROVALS (CORE) — pure: no DB import; store is injected
// ============================================================================
// Replaces the old `humanApprovalToken` rubber stamp (any non-empty string).
//
//   issue    : only with a verified admin session. Mints an opaque 256-bit
//              token bound to (action, subjectType, subjectId, scopeHash),
//              valid for APPROVAL_TTL_MS. Only SHA-256(token) is stored.
//   consume  : at the irreversible boundary, immediately before the external
//              side effect. One atomic conditional UPDATE enforces: token
//              known, not yet consumed, not expired, and EXACTLY the same
//              action/subject/scope. Re-verifies the approver's admin session
//              is still live. Returns a VerifiedApproval capability.
//   adapters : accept ONLY a VerifiedApproval (never a string) and re-assert
//              it matches the action/subject they are about to perform.
//
// A leaked/replayed/forged/misrouted token therefore cannot publish, deploy,
// or roll back anything. Operator bearer tokens can NOT mint approvals.
// ============================================================================
// Production code should import from './approvals' (default Prisma store).
// Pure modules (adapters, lifecycle guard, contracts) import capability types
// from here so they stay free of any database dependency.
// ============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { toCanonicalJson } from '@/lib/product-factory/canonical';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const MAX_APPROVAL_TOKEN_CHARS = 512;

/** action -> the only subject type that action may be bound to. */
export const APPROVAL_ACTIONS = {
  PUBLISH_OFFER: 'offer',
  PUBLISH_PRODUCT: 'product',
  DEPLOY_PRODUCT: 'product',
  ROLLBACK_DEPLOYMENT: 'deployment',
  LIFECYCLE_DEPLOY: 'product',
  LIFECYCLE_PUBLISH: 'product',
} as const;

export type ApprovalAction = keyof typeof APPROVAL_ACTIONS;
export type ApprovalSubjectType = (typeof APPROVAL_ACTIONS)[ApprovalAction];

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_ACTIONS, value);
}

export type ApprovalDenial =
  | 'MISSING' | 'INVALID' | 'EXPIRED' | 'CONSUMED' | 'MISMATCH' | 'APPROVER_SESSION_ENDED' | 'STORE_ERROR';

export interface ApprovalGrantRow {
  id: string;
  tokenHash: string;
  action: string;
  subjectType: string;
  subjectId: string;
  scopeHash: string;
  approverSessionId: string;
  approverEmail: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Narrow persistence seam (tests inject an in-memory store). */
export interface ApprovalStore {
  create(row: Omit<ApprovalGrantRow, 'id' | 'consumedAt'>): Promise<{ id: string }>;
  find(tokenHash: string): Promise<ApprovalGrantRow | null>;
  /** ATOMIC: returns 1 only if the row matched every condition and was unconsumed. */
  consume(where: {
    tokenHash: string; action: string; subjectType: string; subjectId: string; scopeHash: string; now: Date;
  }, consumedBy: string): Promise<number>;
  sessionLive(sessionId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Capability: only this module can mint one
// ---------------------------------------------------------------------------

const MINT = Symbol('approval-mint');

export class VerifiedApproval {
  readonly grantId: string;
  readonly action: ApprovalAction;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly approverEmail: string;
  constructor(mint: symbol, init: {
    grantId: string; action: ApprovalAction; subjectType: ApprovalSubjectType; subjectId: string; approverEmail: string;
  }) {
    if (mint !== MINT) throw new Error('VerifiedApproval can only be created by consumeApproval().');
    this.grantId = init.grantId;
    this.action = init.action;
    this.subjectType = init.subjectType;
    this.subjectId = init.subjectId;
    this.approverEmail = init.approverEmail;
    Object.freeze(this);
  }
}

export function isVerifiedApproval(value: unknown): value is VerifiedApproval {
  return value instanceof VerifiedApproval;
}

/** Adapter-side re-assertion: the capability must match what is about to happen. */
export function approvalCovers(
  approval: unknown,
  expected: { action: ApprovalAction; subjectId: string },
): approval is VerifiedApproval {
  return (
    isVerifiedApproval(approval)
    && approval.action === expected.action
    && approval.subjectType === APPROVAL_ACTIONS[expected.action]
    && approval.subjectId === expected.subjectId
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Content hash of the exact subject state the approver reviewed. */
export function approvalScopeHash(scope: Record<string, unknown>): string {
  return createHash('sha256').update(toCanonicalJson(scope), 'utf8').digest('hex');
}

/** What an offer approval is bound to (changing price/title/product voids it). */
export function offerApprovalScope(offer: {
  id: string; title: string; price: number; currency: string; status: string; halalStatus: string; productId: string | null;
}): Record<string, unknown> {
  return {
    id: offer.id, title: offer.title, price: offer.price, currency: offer.currency,
    status: offer.status, halalStatus: offer.halalStatus, productId: offer.productId ?? null,
  };
}

/** What a product approval is bound to (a state change voids it). */
export function productApprovalScope(product: { id: string; status: string }): Record<string, unknown> {
  return { id: product.id, status: product.status };
}

function wellFormed(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 32 && token.length <= MAX_APPROVAL_TOKEN_CHARS
    && /^[A-Za-z0-9_-]+$/.test(token);
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface ApproverIdentity { sessionId: string; email: string }

export async function issueApproval(
  input: { action: ApprovalAction; subjectId: string; scopeHash: string; approver: ApproverIdentity; now?: Date },
  store: ApprovalStore,
): Promise<{ token: string; expiresAt: Date; grantId: string }> {
  if (!isApprovalAction(input.action)) throw new Error('Unknown approval action.');
  if (!input.subjectId || input.subjectId.length > 128) throw new Error('Invalid approval subject.');
  if (!input.approver?.sessionId) throw new Error('An authenticated admin approver is required.');
  const now = input.now ?? new Date();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
  const { id } = await store.create({
    tokenHash: hashApprovalToken(token),
    action: input.action,
    subjectType: APPROVAL_ACTIONS[input.action],
    subjectId: input.subjectId,
    scopeHash: input.scopeHash,
    approverSessionId: input.approver.sessionId,
    approverEmail: input.approver.email.slice(0, 120),
    expiresAt,
  });
  return { token, expiresAt, grantId: id };
}

// ---------------------------------------------------------------------------
// Consume / peek
// ---------------------------------------------------------------------------

export type ConsumeResult =
  | { ok: true; approval: VerifiedApproval }
  | { ok: false; reason: ApprovalDenial };

function diagnose(row: ApprovalGrantRow, e: { action: string; subjectType: string; subjectId: string; scopeHash: string }, now: Date): ApprovalDenial {
  if (row.action !== e.action || row.subjectType !== e.subjectType || row.subjectId !== e.subjectId || row.scopeHash !== e.scopeHash) return 'MISMATCH';
  if (row.consumedAt) return 'CONSUMED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'INVALID';
}

export async function consumeApproval(
  token: unknown,
  expect: { action: ApprovalAction; subjectId: string; scopeHash: string; surface: string; now?: Date },
  store: ApprovalStore,
): Promise<ConsumeResult> {
  if (token === undefined || token === null || token === '') return { ok: false, reason: 'MISSING' };
  if (!wellFormed(token) || !isApprovalAction(expect.action)) return { ok: false, reason: 'INVALID' };
  const now = expect.now ?? new Date();
  const subjectType = APPROVAL_ACTIONS[expect.action];
  const tokenHash = hashApprovalToken(token);
  try {
    const row = await store.find(tokenHash);
    if (!row) return { ok: false, reason: 'INVALID' };
    // The approver must still be a live admin at the moment of use.
    if (!(await store.sessionLive(row.approverSessionId))) return { ok: false, reason: 'APPROVER_SESSION_ENDED' };
    const match = { tokenHash, action: expect.action, subjectType, subjectId: expect.subjectId, scopeHash: expect.scopeHash, now };
    const changed = await store.consume(match, expect.surface);
    if (changed !== 1) return { ok: false, reason: diagnose(row, match, now) };
    return {
      ok: true,
      approval: new VerifiedApproval(MINT, {
        grantId: row.id, action: expect.action, subjectType, subjectId: expect.subjectId, approverEmail: row.approverEmail,
      }),
    };
  } catch {
    return { ok: false, reason: 'STORE_ERROR' }; // fail closed
  }
}

/**
 * NON-consuming validity probe for pre-checks that must not spend the grant
 * (e.g. reporting NOT_AUTHORIZED early). It is NEVER authority to act: only a
 * VerifiedApproval returned by consumeApproval() is.
 */
export async function peekApproval(
  token: unknown,
  expect: { action: ApprovalAction; subjectId: string; scopeHash: string; now?: Date },
  store: ApprovalStore,
): Promise<boolean> {
  if (!wellFormed(token) || !isApprovalAction(expect.action)) return false;
  const now = expect.now ?? new Date();
  try {
    const row = await store.find(hashApprovalToken(token));
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return false;
    if (row.action !== expect.action || row.subjectType !== APPROVAL_ACTIONS[expect.action]
      || row.subjectId !== expect.subjectId || row.scopeHash !== expect.scopeHash) return false;
    return await store.sessionLive(row.approverSessionId);
  } catch {
    return false;
  }
}

export const APPROVAL_DENIAL_MESSAGE =
  'A valid, unexpired, unused approval for exactly this action and subject is required. Nothing was performed. '
  + 'Obtain a fresh approval from an authenticated admin (POST /api/approvals).';
