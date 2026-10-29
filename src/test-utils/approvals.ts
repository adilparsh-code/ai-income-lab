// Test support for the single-use approval contract (src/lib/security/approvals-core.ts).
//
// NOTHING here fabricates authority: a VerifiedApproval can only be produced by
// consumeApproval(), so tests mint one through the REAL issue -> consume path
// against an in-memory store. A test that wants a *denial* simply reuses a
// consumed token, changes the subject/scope, lets it expire, or ends the
// approver session — exactly what production would see.

import {
  approvalScopeHash,
  consumeApproval,
  peekApproval,
  issueApproval,
  type ApprovalAction,
  type ApprovalGrantRow,
  type ApprovalStore,
  type ConsumeResult,
  type VerifiedApproval,
} from '@/lib/security/approvals-core';

export class InMemoryApprovalStore implements ApprovalStore {
  readonly rows: ApprovalGrantRow[] = [];
  readonly liveSessions = new Set<string>(['test-admin-session']);
  private seq = 0;

  async create(row: Omit<ApprovalGrantRow, 'id' | 'consumedAt'>): Promise<{ id: string }> {
    const id = `grant_${++this.seq}`;
    this.rows.push({ ...row, id, consumedAt: null });
    return { id };
  }
  async find(tokenHash: string): Promise<ApprovalGrantRow | null> {
    return this.rows.find((r) => r.tokenHash === tokenHash) ?? null;
  }
  async consume(
    where: { tokenHash: string; action: string; subjectType: string; subjectId: string; scopeHash: string; now: Date },
    consumedBy: string,
  ): Promise<number> {
    const row = this.rows.find((r) =>
      r.tokenHash === where.tokenHash && r.action === where.action && r.subjectType === where.subjectType
      && r.subjectId === where.subjectId && r.scopeHash === where.scopeHash
      && r.consumedAt === null && r.expiresAt.getTime() > where.now.getTime());
    if (!row) return 0;
    row.consumedAt = where.now; // single-threaded: this is the atomic step
    void consumedBy;
    return 1;
  }
  async sessionLive(sessionId: string): Promise<boolean> {
    return this.liveSessions.has(sessionId);
  }
}

export interface MintOptions {
  action: ApprovalAction;
  subjectId: string;
  /** Scope the approver "reviewed"; defaults to a fixed scope for the subject. */
  scope?: Record<string, unknown>;
  store?: InMemoryApprovalStore;
}

/** Issue + consume through the real code path; returns the token AND the capability. */
export async function mintVerifiedApproval(options: MintOptions): Promise<{ approval: VerifiedApproval; token: string; store: InMemoryApprovalStore }> {
  const store = options.store ?? new InMemoryApprovalStore();
  const scopeHash = approvalScopeHash(options.scope ?? { id: options.subjectId });
  const issued = await issueApproval(
    { action: options.action, subjectId: options.subjectId, scopeHash, approver: { sessionId: 'test-admin-session', email: 'admin@test.local' } },
    store,
  );
  const result: ConsumeResult = await consumeApproval(
    issued.token,
    { action: options.action, subjectId: options.subjectId, scopeHash, surface: 'test' },
    store,
  );
  if (!result.ok) throw new Error(`test approval could not be minted: ${result.reason}`);
  return { approval: result.approval, token: issued.token, store };
}

/** Issue (but do NOT consume) a real token — for code paths that consume it themselves. */
export async function issueTestToken(
  store: InMemoryApprovalStore,
  action: ApprovalAction,
  subjectId: string,
  scope: Record<string, unknown>,
  options: { sessionId?: string; now?: Date } = {},
): Promise<string> {
  const issued = await issueApproval(
    {
      action, subjectId, scopeHash: approvalScopeHash(scope),
      approver: { sessionId: options.sessionId ?? 'test-admin-session', email: 'admin@test.local' },
      now: options.now,
    },
    store,
  );
  return issued.token;
}

/** consume/peek bound to an in-memory store, for modules with an approval-ops test seam. */
export function approvalOpsFor(store: InMemoryApprovalStore) {
  return {
    consume: (token: unknown, expect: Parameters<typeof consumeApproval>[1]) => consumeApproval(token, expect, store),
    peek: (token: unknown, expect: Parameters<typeof peekApproval>[1]) => peekApproval(token, expect, store),
  };
}

// ---------------------------------------------------------------------------
// DATABASE-BACKED variant (requires a generated Prisma client + test database;
// used by the DB tests that run in CI). Still the real issue path: a live
// AdminSession row is the approver, and the token is bound to the offer's CURRENT
// price/title/status/product exactly as production binds it.
// ---------------------------------------------------------------------------

export async function createLiveAdminSession(options: { expiresInMs?: number } = {}): Promise<{ id: string; email: string }> {
  const { db } = await import('@/lib/db');
  const row = await db.adminSession.create({
    data: {
      tokenFingerprint: `test-fp-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      email: 'admin@aiincome.lab',
      expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3_600_000)),
      createdBy: 'test',
    },
  });
  return { id: row.id, email: row.email };
}

export async function issueOfferApprovalFromDb(
  offerId: string,
  options: { sessionId?: string; now?: Date } = {},
): Promise<string> {
  const { db } = await import('@/lib/db');
  const { issueApproval, prismaApprovalStore, offerApprovalScope } = await import('@/lib/security/approvals');
  void prismaApprovalStore;
  const offer = await db.offer.findUniqueOrThrow({ where: { id: offerId } });
  const session = options.sessionId ? { id: options.sessionId, email: 'admin@aiincome.lab' } : await createLiveAdminSession();
  const issued = await issueApproval({
    action: 'PUBLISH_OFFER',
    subjectId: offerId,
    scopeHash: approvalScopeHash(offerApprovalScope({
      id: String(offer.id), title: String(offer.title), price: Number(offer.price), currency: String(offer.currency),
      status: String(offer.status), halalStatus: String(offer.halalStatus),
      productId: typeof offer.productId === 'string' ? offer.productId : null,
    })),
    approver: { sessionId: session.id, email: session.email },
    now: options.now,
  });
  return issued.token;
}
