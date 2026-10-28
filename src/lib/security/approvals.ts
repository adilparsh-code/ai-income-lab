// ============================================================================
// HUMAN APPROVALS — production entry point (Prisma-backed store)
// ============================================================================
// See approvals-core.ts for the model. These wrappers bind the default
// database store; tests call the core functions with an in-memory store.
// ============================================================================

import { db } from '@/lib/db';
import { isAdminSessionLive } from '@/lib/agency/admin-auth';
import {
  consumeApproval as consumeApprovalCore,
  issueApproval as issueApprovalCore,
  peekApproval as peekApprovalCore,
  type ApprovalStore,
} from './approvals-core';

export * from './approvals-core';

export const prismaApprovalStore: ApprovalStore = {
  async create(row) {
    const created = await db.approvalGrant.create({ data: row, select: { id: true } });
    return { id: created.id };
  },
  async find(tokenHash) {
    return db.approvalGrant.findUnique({ where: { tokenHash } });
  },
  async consume(where, consumedBy) {
    const { now, ...match } = where;
    // ATOMIC single-use: one conditional UPDATE; count===1 only for the one
    // caller that flips consumedAt from NULL while every binding still matches.
    const result = await db.approvalGrant.updateMany({
      where: { ...match, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now, consumedBy: consumedBy.slice(0, 120) },
    });
    return result.count;
  },
  sessionLive: isAdminSessionLive,
};

export const issueApproval = (input: Parameters<typeof issueApprovalCore>[0]) =>
  issueApprovalCore(input, prismaApprovalStore);
export const consumeApproval = (token: unknown, expect: Parameters<typeof consumeApprovalCore>[1]) =>
  consumeApprovalCore(token, expect, prismaApprovalStore);
export const peekApproval = (token: unknown, expect: Parameters<typeof peekApprovalCore>[1]) =>
  peekApprovalCore(token, expect, prismaApprovalStore);
